// The façade the plugin, tests and eval all drive (handoff.md §5).
// At M2d this exposes the full compile — discover → normalize → extract
// (Call A) → generate (Call B) → post-process → index — with §6.6's cascade
// folded through it, plus the scope preview §5 names.
import type { FsAdapter, HttpAdapter } from "./adapters";
import { mapWithConcurrency } from "./concurrency";
import { cascadeScope, type ScopePreview } from "./compile/cascade";
import { parseCitationBlock, withCitationBlock } from "./compile/citations";
import {
  discover,
  type DiscoveredSource,
  type DiscoveryResult,
  type SkippedSource,
} from "./compile/discover";
import {
  citerUnion,
  generatePageBody,
  readablePathFor,
  readCitations,
  renderPage,
  type PageToWrite,
} from "./compile/generate";
import { bodyOf, takeInventory, type SourceInventory } from "./compile/inventory";
import {
  carryRenames,
  removeSupersededDerivative,
  sweepDeparted,
  type CarryOutcome,
  type Report,
} from "./compile/renames";
import { buildTitleIndex } from "./compile/links";
import { mergeInventories, type SourceInventoryEntry } from "./compile/dedup";
import { INDEX_PATH, renderIndex } from "./compile/indexdoc";
import {
  handleOf,
  loadPageTable,
  pagePathForKind,
  sanitizeTitle,
  takenTitles,
  uniqueTitle,
} from "./compile/pagetable";
import { decodeUtf8 } from "./hash";
import { OperationLock } from "./lock";
import {
  CASCADE_PENDING,
  isPending,
  isSameManifest,
  loadManifest,
  saveManifest,
} from "./manifest";
import {
  derivativeOrigin,
  formatForPath,
  isPassthrough,
  normalizeSource,
} from "./normalize/index";
import { comparePaths, dirname, stem } from "./paths";
import { createProvider } from "./provider/wrapper";
import type { LLMProvider } from "./provider/types";
import { buildGraph } from "./graph/build";
import { computePPR, type PPRResult } from "./graph/ppr";
import { assemble } from "./retrieve/assemble";
import {
  forceIncludeSeeds,
  modeOf,
  rankModeA,
  rankModeB,
  selectSeeds,
  type RankedNode,
} from "./retrieve/pipeline";
import { answerNotePath, renderAnswerNote, synthesize } from "./answer/synthesize";
import { fileBack } from "./answer/fileback";
import { healthCheck } from "./health";
import {
  normalizeSettings,
  type GraphSnapshot,
  type IngestManifest,
  type LukaSettings,
  type ManifestEntry,
  type OperationName,
  type PageMeta,
  type RetrievalMode,
} from "./types";
import { parseFrontmatter, serializeFrontmatter } from "./yaml";

export type { FsAdapter, HttpAdapter } from "./adapters";
export { BusyError } from "./lock";
export type { ScopePreview } from "./compile/cascade";
export type { SkippedSource } from "./compile/discover";
// §17's clamps are core's, so a consumer reading a settings number gets the
// same value the operation would — the pane's top-K is §17's own K.
export { DEFAULT_SETTINGS, normalizeSettings } from "./types";
export type { IngestManifest, LukaSettings, ManifestEntry, ProviderTask } from "./types";
export type { GraphEdge, GraphNode, GraphSnapshot, RetrievalMode } from "./types";
// §7.1's node set — "every manifest source's readable markdown" — is exactly
// this value per entry. Exported here rather than from manifest.ts so callers
// outside core keep going through the one façade.
export { readablePathOf } from "./manifest";
export { FILED_ANSWERS_FOLDER } from "./answer/fileback";
export { HEALTH_PATH } from "./health";
export {
  parseTrace,
  resolveTraceNodes,
  writeTrace,
  type ResolvedTrace,
  type Trace,
} from "./answer/trace";
export type { PPROptions, PPRResult } from "./graph/ppr";
// §9's maturity banner is §7.3's predicate, and a second copy of it in the
// plugin would be a copy that could disagree with the one retrieval uses.
export { modeOf, type RankedNode } from "./retrieve/pipeline";
// The raw transport (provider/anthropic.ts) is deliberately NOT exported:
// invariant 10 requires every provider call to pass through the wrapper, and
// keeping the transport module-internal makes a bypass structurally awkward.
export { createProvider } from "./provider/wrapper";
export { MAX_TOKENS_BY_TASK, ProviderError } from "./provider/types";
export type { CompletionRequest, LLMProvider, ProviderStats } from "./provider/types";

export interface CoreDeps {
  fs: FsAdapter;
  http: HttpAdapter;
  /** Where the ingest manifest lives — inside the plugin folder, not the vault tree. */
  manifestPath: string;
  settings: LukaSettings;
  /** Injected so `ingested` dates are reproducible in tests. */
  now?: () => Date;
  /**
   * Test seam. Defaults to the §11 reliability wrapper over the configured
   * provider — the seam is at wrapper level, never at transport level, so
   * invariant 10 cannot be bypassed through it.
   */
  provider?: LLMProvider;
}

export interface CompileFailure {
  path: string;
  reason: string;
}

export interface CompileResult {
  added: number;
  modified: number;
  unchanged: number;
  deleted: number;
  renamed: number;
  skipped: SkippedSource[];
  failed: CompileFailure[];
  /**
   * Work this compile completed differently than intended, and files it chose
   * not to touch. Distinct from `failed`: nothing here is retried, because
   * there is nothing left owed — a rename that fell back to re-extraction got
   * its markdown, it just cost a model call, and a file left alone was never
   * Luka's to remove. Reported so neither passes silently.
   */
  reported: CompileFailure[];
  /** Wiki pages written this run. */
  pagesWritten: number;
  /** Wiki pages the §6.6 cascade deleted — their last citer is gone. */
  pagesDeleted: number;
  /**
   * Files under `raw/` the cascade removed: derivatives orphaned by a source
   * leaving its path. `raw/` is the user's folder, so a compile says when it
   * has taken something out of it (§6.6's preview covers pages only).
   */
  derivativesDeleted: number;
  /** Provider calls this run — invariant 12's deterministic count. */
  modelCalls: number;
  /** True when the run wrote nothing at all. */
  noop: boolean;
  /** True when the scope preview was declined; nothing was read past discovery. */
  cancelled: boolean;
}

export type ProgressEvent =
  | { phase: "discovering" }
  | { phase: "normalizing"; path: string; index: number; total: number }
  | { phase: "inventory"; path: string; index: number; total: number }
  | { phase: "generating"; title: string; index: number; total: number }
  | { phase: "writing-index" }
  | { phase: "writing-manifest" };

export interface CompileOptions {
  onProgress?: (event: ProgressEvent) => void;
  /**
   * §8.1's confirm step. Called — inside the operation lock, before any work —
   * whenever the diff includes deletions or modifications, which is exactly
   * when §6.6 asks for the scope preview. Returning false abandons the run
   * having written nothing. Omitting it proceeds unconfirmed, which is what
   * tests and the headless eval harness want; the modal is the plugin's.
   */
  confirm?: (preview: ScopePreview) => Promise<boolean> | boolean;
}

/** What §9's query inspection overlays: §7.4 steps 1–3, with nothing assembled. */
export interface InspectResult {
  /** §7.3's predicate over the graph this ranked against. */
  mode: RetrievalMode;
  /**
   * Seed page paths: the model's choices union §7.4 step 2's force-includes,
   * narrowed to nodes that are on the snapshot this ranked against.
   *
   * The narrowing can drop a page the question named outright, which §7.4
   * step 2 calls "not a guess that needs rationing" — but a page absent from
   * the snapshot cannot be lit on a pane drawing that snapshot, and showing
   * it as a seed the overlay then ignores would be the worse lie. Refresh is
   * the control §9 gives the user for it.
   */
  seeds: string[];
  /** The keywords the seed call returned, which Mode A ranks with. */
  keywords: string[];
  /** §7.4 step 3's ranking, best first. */
  ranked: RankedNode[];
}

export interface Core {
  compile(options?: CompileOptions): Promise<CompileResult>;
  /** §5's read-only scope preview: no lock, no model call, no write. */
  previewCompile(): Promise<ScopePreview>;
  /**
   * §7.1's graph, built in memory and cached until the next compile. Async
   * because the build reads the vault, and §7.1 asks for one at plugin load —
   * which the plugin starts by calling this.
   */
  getGraph(): Promise<GraphSnapshot>;
  /**
   * §5's `ask`: §7's retrieval into §8's answer note. Holds the operation lock
   * (invariant 2) and writes the note atomically on success only
   * (invariant 11).
   */
  ask(question: string): Promise<AnswerResult>;
  /**
   * §8.4: moves an answer note into `raw/answers/`, stripping the trace and
   * keeping the sources block, and returns where it landed. No auto-compile —
   * the next compile picks it up through the normal path.
   */
  fileBack(answerPath: string): Promise<string>;
  /**
   * §10: rewrites `wiki/_health.md` from one vault scan, with no model
   * calls. Holds the lock — it reads the whole vault and writes a file, so a
   * compile running underneath it would make the report describe a vault that
   * no longer exists.
   */
  healthCheck(): Promise<void>;
  /** §7.2's personalized PageRank over the current graph. */
  computePPR(
    seedPaths: readonly string[],
    options?: { snapshots?: boolean },
  ): Promise<PPRResult>;
  /**
   * §9's "Inspect (1 model call)": §7.4 steps 1–3 and nothing after them.
   *
   * Steps 4 and 5 — assembly and the ungrounded skip — belong to answering,
   * not to showing what retrieval selected, and they are what the second and
   * third of invariant 12's three calls pay for. Stopping at ranking is what
   * makes the button's label true.
   *
   * Takes no lock and writes nothing, so it answers while a compile runs —
   * §9's pane is never blocked by the lock.
   */
  inspect(question: string): Promise<InspectResult>;
  /**
   * §7.1: "Built in memory at plugin load and after compile." Returns an
   * unsubscribe, so a view that closes stops hearing about rebuilds.
   */
  onGraphRebuilt(callback: (graph: GraphSnapshot) => void): () => void;
  readonly busyWith: OperationName | null;
}

export function createCore(deps: CoreDeps): Core {
  const lock = new OperationLock();
  // §7.1's graph lives here and nowhere on disk: "built in memory at plugin
  // load and after compile; no cache file". `building` collapses concurrent
  // callers onto one build rather than letting two walk the vault at once.
  let graph: GraphSnapshot | null = null;
  let building: Promise<GraphSnapshot> | null = null;
  const listeners = new Set<(graph: GraphSnapshot) => void>();

  /**
   * Bumped whenever the vault changes underneath an in-flight build. A build
   * that started before the change publishes nothing when it lands.
   *
   * `building` collapses concurrent callers onto one walk, which is right while
   * the vault is still — but M4 gave the graph readers that run *outside* the
   * lock (§9's pane calls `getGraph`, `computePPR` and `inspect` while a compile
   * runs). Without this, a rebuild the pane started before a compile's writes
   * was still in flight when the compile finished, and the compile's own
   * `rebuildGraph()` adopted it: a snapshot missing every page that compile had
   * just written, cached and broadcast as if it were current, and not corrected
   * until the next compile.
   */
  let generation = 0;

  function rebuildGraph(): Promise<GraphSnapshot> {
    if (building !== null) return building;

    const mine = generation;
    // A handle on this build's own promise, so the cleanup below can tell
    // whether it still owns the slot.
    const own: { promise: Promise<GraphSnapshot> | null } = { promise: null };

    own.promise = buildGraph({ fs: deps.fs, manifestPath: deps.manifestPath })
      .then((built) => {
        // A newer generation means the vault moved while this walked, so this
        // is not the cached answer for anyone.
        if (mine === generation) {
          graph = built;
          for (const listener of listeners) listener(built);
        }
        return currentOrNewer(built, mine);
      })
      .finally(() => {
        // Only if this build still owns the slot. `invalidateGraph` may have
        // cleared it and a newer build installed itself since; clobbering that
        // one sends the next reader off on a third redundant walk.
        if (building === own.promise) building = null;
      });

    building = own.promise;
    return building;
  }

  /** Retires any in-flight build, so the next one starts after this moment. */
  function invalidateGraph(): void {
    generation += 1;
    building = null;
  }

  /**
   * The snapshot a reader should act on: the cached one when this build was
   * superseded while it walked.
   *
   * A build that loses its generation publishes nothing, which keeps the cache
   * right — but its caller was still handed the stale snapshot it had asked
   * for, and the pane assigns whatever it is given. So a refresh racing a
   * compile overwrote the fresh graph it had just been notified of with the
   * older one it was awaiting, and stayed stale until the next compile.
   */
  function currentOrNewer(built: GraphSnapshot, mine: number): GraphSnapshot {
    return mine === generation || graph === null ? built : graph;
  }

  // `deps` is passed through, not copied. The plugin mutates its settings
  // object in place and this runs once in `onload()`, so a snapshot here would
  // freeze the API key as it stood at load — invariant 9 requires it be read
  // when the call is made. Each run makes §17's numbers safe for itself.
  return {
    compile: async (options: CompileOptions = {}) => {
      const result = await lock.run("compile", () => runCompile(deps, options));
      // "and after compile" (§7.1). A declined preview changed nothing, so
      // there is nothing to rebuild from.
      if (!result.cancelled) {
        // Retire first: a build begun before these writes cannot describe them,
        // and joining it would cache a graph that is already wrong.
        invalidateGraph();
        await rebuildGraph();
      }
      return result;
    },
    ask: (question: string) => lock.run("ask", () => runAsk(deps, question)),
    // Outside the lock: no model calls, no compile, and §8.4 ends at a notice.
    fileBack: (answerPath: string) => fileBack(deps.fs, answerPath),
    healthCheck: () =>
      lock.run("health check", () =>
        healthCheck({
          fs: deps.fs,
          manifestPath: deps.manifestPath,
          ...(deps.now === undefined ? {} : { now: deps.now }),
        }),
      ),
    getGraph: () => (graph === null ? rebuildGraph() : Promise.resolve(graph)),
    computePPR: async (seedPaths, options = {}) => {
      const settings = normalizeSettings(deps.settings);
      return computePPR(await (graph === null ? rebuildGraph() : Promise.resolve(graph)), seedPaths, {
        alpha: settings.pprAlpha,
        maxIterations: settings.pprMaxIterations,
        ...(options.snapshots === true ? { snapshots: true } : {}),
      });
    },
    // Outside the lock, like `computePPR` and for the same reason: it writes
    // nothing, and §9's pane is never blocked by the lock.
    inspect: async (question: string) =>
      runInspect(deps, await (graph === null ? rebuildGraph() : Promise.resolve(graph)), question),
    onGraphRebuilt: (callback: (graph: GraphSnapshot) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    // Deliberately outside the lock: it does no work and writes nothing, so it
    // can answer while a compile runs — the same reason §9's pane is never
    // blocked by the lock. §8.1's flow does not use it; compile's own confirm
    // callback holds the lock across preview → confirm → work.
    previewCompile: () => runPreview(deps),
    get busyWith(): OperationName | null {
      return lock.busyWith;
    },
  };
}

/**
 * §9's query inspection: §7.4 steps 1–3 over the graph the pane is showing.
 *
 * The first three stanzas are `runAsk`'s, deliberately in the same order and
 * reading the same settings, because the overlay claims to show what an ask
 * *would* retrieve. Two differences, both forced by what the pane is:
 *
 * It ranks against the snapshot it is handed rather than building a fresh one.
 * §9 says the pane "renders the last-built snapshot", and an overlay ranked
 * over a graph the user cannot see would light nodes that are not on screen.
 *
 * It stops after ranking. Assembly reads every candidate page off disk to fill
 * a context budget nothing here will spend, and §7.4 step 5's ungrounded branch
 * is a property of an answer, not of a ranking.
 */
async function runInspect(
  input: CoreDeps,
  graph: GraphSnapshot,
  question: string,
): Promise<InspectResult> {
  const deps: CoreDeps = { ...input, settings: normalizeSettings(input.settings) };
  const provider = deps.provider ?? createProvider({ http: deps.http, settings: deps.settings });

  const pages = await loadPageTable(deps.fs);

  // §7.4 step 1: the renderer that writes `wiki/_index.md`, so the seed call
  // sees the same text the user does.
  const indexText = renderIndex(pages);
  // Step 2, and invariant 12's one call. Everything after this is arithmetic.
  const chosen = await selectSeeds(provider, question, indexText, pages, {
    seeds: deps.settings.seedsCap,
    keywords: deps.settings.keywordsCap,
  });

  const chosenSeeds = [...new Set([...chosen.seeds, ...forceIncludeSeeds(question, pages)])].sort(
    comparePaths,
  );

  // Everything ranked has to be *on* the snapshot the pane is drawing, and
  // that has to be true in both modes.
  //
  // The page table is read fresh, because the seed call needs `_index.md`'s
  // text and §4's aliases, and neither survives on a `GraphNode`. So the two
  // can disagree: a page written since the last rebuild is in `pages` and not
  // in `graph`. Left alone that showed up twice, differently — Mode B fed such
  // a seed to `computePPR`, which drops seeds it cannot find and returns an
  // empty map, so the overlay came back silently blank; Mode A ranked the
  // fresh table and lit nodes that are not on screen, which is the exact thing
  // ranking over the snapshot was supposed to prevent.
  //
  // Both are narrowed to the snapshot here. What the user does about a page
  // that is missing is Refresh, which is the control §9 gives them.
  const onGraph = new Set(graph.nodes.map((node) => node.path));
  const seeds = chosenSeeds.filter((path) => onGraph.has(path));
  const candidates = pages.filter((page) => onGraph.has(page.path));

  // §7.3: the seed call runs in both modes; the mode governs ranking only.
  const mode = modeOf(graph, deps.settings);
  const ranked =
    mode === "B"
      ? rankModeB(graph, seeds, deps.settings)
      : await rankModeA(deps.fs, candidates, seeds, chosen.keywords);

  return { mode, seeds, keywords: chosen.keywords, ranked };
}

/** §5's `previewCompile`. Every step here reads; none of them writes. */
async function runPreview(input: CoreDeps): Promise<ScopePreview> {
  const deps: CoreDeps = { ...input, settings: normalizeSettings(input.settings) };
  const manifest = await loadManifest(deps.fs, deps.manifestPath);
  const discovery = await discover(deps.fs, manifest);
  const pages = await loadPageTable(deps.fs);
  return cascadeScope(pages, await readCitations(deps.fs, pages), discovery);
}

/** §5's `ask`. §8.3 names what the caller needs back. */
export interface AnswerResult {
  /** Vault path of the note written. */
  path: string;
  mode: RetrievalMode;
  grounded: boolean;
  /** Whether §8.2's follow-up round ran. */
  round2: boolean;
  /**
   * Logical model calls, which is what invariant 12 bounds at three — not
   * transport attempts. §11's retries and its one repair recover a single
   * logical call; counting them here would report a violation whenever the
   * network hiccuped.
   */
  modelCalls: number;
}

/**
 * §7.4's pipeline into §8.2's synthesis into §8.3's note.
 *
 * Invariant 11: "Answer notes are written atomically on success only; a failed
 * query writes nothing." Every model call happens, the whole note is rendered
 * into one string, and only then is anything written — so there is no partial
 * state a failure could leave behind, and nothing to roll back. The same
 * single-commit shape as the manifest.
 *
 * Invariant 12 bounds this at three calls: one seed selection, one synthesis,
 * and at most one more for §8.2's follow-up round.
 */
async function runAsk(input: CoreDeps, question: string): Promise<AnswerResult> {
  const deps: CoreDeps = { ...input, settings: normalizeSettings(input.settings) };
  const provider = deps.provider ?? createProvider({ http: deps.http, settings: deps.settings });
  // Invariant 12 bounds *logical* calls: "ask = ≤ 3 calls". `stats().requests`
  // and `byTask` both count transport attempts — they increment together
  // inside the retry loop — so neither is this number. §11's retries and its
  // one repair are recovery of a single logical call, not extra calls, and
  // reporting them as calls would make the invariant look violated whenever
  // the network hiccuped. Counted here, where the calls are made.
  let modelCalls = 0;
  const called = <T,>(work: Promise<T>): Promise<T> => {
    modelCalls += 1;
    return work;
  };

  const pages = await loadPageTable(deps.fs);
  const graph = await buildGraph({ fs: deps.fs, manifestPath: deps.manifestPath });

  // §7.4 step 1: the same renderer that writes `wiki/_index.md`, so the seed
  // call and the file the user reads can never drift apart.
  const indexText = renderIndex(pages);
  const chosen = await called(
    selectSeeds(provider, question, indexText, pages, {
      seeds: deps.settings.seedsCap,
      keywords: deps.settings.keywordsCap,
    }),
  );

  // §7.4 step 2: force-includes are additive to whatever the model chose.
  const seedPaths = [...new Set([...chosen.seeds, ...forceIncludeSeeds(question, pages)])].sort(
    comparePaths,
  );

  // §7.3: the seed call runs in both modes; the mode governs ranking only.
  const mode = modeOf(graph, deps.settings);
  const ranked =
    mode === "B"
      ? rankModeB(graph, seedPaths, deps.settings)
      : await rankModeA(deps.fs, pages, seedPaths, chosen.keywords);

  let assembly = await assemble(
    deps.fs,
    ranked,
    deps.settings.contextBudgetTokens,
    deps.settings.assemblyCap,
  );

  // §7.4 step 5: "Zero seeds and zero lexical candidates → skip retrieval;
  // synthesis runs from model knowledge and the answer is labeled ungrounded."
  const grounded = assembly.nodes.length > 0;
  let reply = await called(synthesize(provider, question, assembly.nodes));

  // §8.2's follow-up round: "identical in both modes: lexical-score the
  // missing-information strings (as keywords) over wiki pages, take the
  // highest scorers not already assembled, append them under the remaining
  // context budget, and synthesize again with the union. No second seed call,
  // no second PPR. Hard cap: one follow-up round."
  let round2 = false;
  if (reply.missing.length > 0 && deps.settings.followUpEnabled) {
    const already = new Set(assembly.nodes.map((node) => node.path));
    // Wiki pages only, whatever the mode ranked — §8.2 says so, and it is why
    // this uses the lexical scorer rather than re-running the walk.
    const candidates = await rankModeA(
      deps.fs,
      pages.filter((page) => !already.has(page.path)),
      [],
      reply.missing,
    );
    const remaining = deps.settings.contextBudgetTokens - assembly.usedTokens;
    const room = deps.settings.assemblyCap - assembly.nodes.length;

    if (candidates.length > 0 && remaining > 0 && room > 0) {
      const extra = await assemble(deps.fs, candidates, remaining, room);
      // A second synthesis is only worth a model call if it has something new
      // to read. Nothing appended means the round would ask the same question
      // of the same context and spend invariant 12's third call on it.
      if (extra.nodes.length > 0) {
        assembly = {
          nodes: [...assembly.nodes, ...extra.nodes],
          usedTokens: assembly.usedTokens + extra.usedTokens,
        };
        reply = await called(synthesize(provider, question, assembly.nodes));
        round2 = true;
      }
    }
  }

  const asked = (deps.now ?? (() => new Date()))();
  const note = renderAnswerNote({
    question,
    asked: asked.toISOString(),
    mode,
    grounded,
    body: reply.body,
    consulted: assembly.nodes,
    pages,
    trace: {
      mode,
      // Named the way §8.3's example names them, and the way §4 spells a link:
      // a wiki page by its title, a raw source by its path. `top` already did;
      // seeds carried vault paths, so one four-line block used two vocabularies
      // and §5's shared `parseTrace` had to resolve both.
      seeds: seedPaths.map((path) => labelFor(path, pages)),
      round2,
      unparsed: [],
      top: assembly.nodes.map((node) => ({
        label: node.kind === "raw" ? node.path : node.title,
        score: ranked.find((candidate) => candidate.path === node.path)?.score ?? 0,
      })),
    },
  });

  const path = await freeAnswerPath(deps.fs, answerNotePath(question, asked));
  await deps.fs.mkdir(dirname(path));
  await deps.fs.write(path, note);

  return {
    path,
    mode,
    grounded,
    round2,
    modelCalls,
  };
}

/** §4's link form for a node: a wiki page by title, anything else by path. */
function labelFor(path: string, pages: readonly PageMeta[]): string {
  return pages.find((page) => page.path === path)?.title ?? path;
}

/**
 * §8.4's suffix idiom, applied to the answer folder: two questions asked in one
 * minute would otherwise name one file, and the second would overwrite the
 * first.
 */
async function freeAnswerPath(fs: FsAdapter, wanted: string): Promise<string> {
  if (!(await fs.exists(wanted))) return wanted;
  const base = wanted.slice(0, -".md".length);
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}.md`;
    if (!(await fs.exists(candidate))) return candidate;
  }
}

/**
 * A citing source whose readable markdown cannot be located — it is in the
 * vault but outside what compile can process, so no retry of anyone else's
 * work would produce it. Distinguished from an ordinary failure because the
 * §6.5 citer set cannot be satisfied at all, rather than not yet.
 */
class UnreadableCiter extends Error {
  constructor(path: string) {
    super(`no readable markdown for ${path}`);
    this.name = "UnreadableCiter";
  }
}

/** A source that normalized successfully and is ready for Call A. */
interface NormalizedSource {
  source: DiscoveredSource;
  hash: string;
  readablePath: string;
  /**
   * The derivative this normalization wrote, or `null` for a passthrough source
   * that is its own readable markdown. Recorded in the manifest rather than
   * re-derived later: this is the one moment ownership is known for certain.
   */
  derivativePath: string | null;
}

/**
 * Wraps a provider so every `complete()` is counted once.
 *
 * Sits *above* the wrapper, never below it, so invariant 10 still holds — the
 * transport is untouched and §11's retries happen inside the call being
 * counted. That is what makes the tally logical rather than transport: one
 * count per call the worklist asked for, whatever the network did with it.
 */
function countingProvider(inner: LLMProvider, onCall: () => void): LLMProvider {
  const complete = inner.complete.bind(inner) as (request: unknown) => Promise<unknown>;
  return {
    complete: ((request: unknown) => {
      onCall();
      return complete(request);
    }) as LLMProvider["complete"],
    stats: () => inner.stats(),
  };
}

async function runCompile(input: CoreDeps, options: CompileOptions): Promise<CompileResult> {
  // One consistent settings state for the whole run, taken now rather than at
  // `createCore`, so a key typed since load is seen and a key typed mid-run
  // cannot change the rules underneath a compile already in flight.
  const deps: CoreDeps = { ...input, settings: normalizeSettings(input.settings) };
  const emit = options.onProgress ?? (() => {});
  const wrapped = deps.provider ?? createProvider({ http: deps.http, settings: deps.settings });
  // Invariant 12 bounds compile by "S inventory calls + P page-generation calls
  // (+1 vision call per orphan image)" — a function of the worklist. §11's
  // retries and its one repair are transport, not worklist, so a `requests`
  // delta reports a number the invariant never promised: one source whose
  // inventory needs repairing reads 2, and a 503 storm reads more still. This
  // is the counter `runAsk` was given for the same reason; compile kept the
  // delta. Counting one call per `complete()` — above the wrapper, so retries
  // stay underneath it — is the same logical count at every site, including the
  // vision call `normalize` makes, which index.ts cannot otherwise see.
  let modelCalls = 0;
  const provider = countingProvider(wrapped, () => {
    modelCalls += 1;
  });
  emit({ phase: "discovering" });

  const manifest = await loadManifest(deps.fs, deps.manifestPath);
  const discovery = await discover(deps.fs, manifest);

  // The wiki as this run found it. Read once: normalization writes only into
  // `raw/`, so this table and these citation records are still exact when the
  // merge reaches for them below.
  let pages = await loadPageTable(deps.fs);
  let citations = await readCitations(deps.fs, pages);

  // ── Scope preview (§6.6, §8.1) ─────────────────────────────────────────
  // "with scope preview when the diff includes deletions or modifications".
  // This sits inside the lock the façade already holds, so the lock spans
  // preview → confirm → work exactly as §8.1 requires, and a second invocation
  // during the modal gets invariant 2's busy notice.
  if ((discovery.deleted.length > 0 || discovery.modified.length > 0) && options.confirm) {
    const preview = cascadeScope(pages, citations, discovery);
    if (!(await options.confirm(preview))) return cancelled(discovery);
  }

  const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  const normalizeDeps = {
    fs: deps.fs,
    http: deps.http,
    timeoutMs: deps.settings.requestTimeoutMs,
    today,
    provider,
  };

  const failed: CompileFailure[] = [];
  const reported: Report[] = [];
  // Markdown an entry names that this run could not read. The source keeps its
  // entry — nothing contradicted it — but it is not left to read as healthy.
  reported.push(...discovery.unreadable);
  let wrote = false;

  // Departed sources whose cascade could not be completed, and why. Their
  // manifest entry is kept at the end, so §6.2's rules see the path leave
  // again next compile and the cascade retries — the same shape invariant 3
  // gives a failed ingest.
  const blockedDeleted = new Map<string, string[]>();

  // ── Sweep (§6.6) ───────────────────────────────────────────────────────
  // The markdown of sources that left the vault. Before the carry and before
  // normalization, so a derivative location a departed source was holding is
  // free for whoever wants it in this very run.
  //
  // Only outright deletions. A renamed source has not left the vault — its old
  // path is where its markdown currently sits, which the carry below is about
  // to use.
  const swept = await sweepDeparted(deps.fs, manifest, discovery.deleted);
  let derivativesDeleted = swept.deleted;
  if (swept.deleted > 0) wrote = true;
  for (const entry of swept.blocked) block(blockedDeleted, entry.path, entry.reason);
  reported.push(...swept.reported);

  // ── Carry (§6.2) ───────────────────────────────────────────────────────
  // A renamed source keeps its derivative rather than rebuilding it: §6.2 says
  // a derivative persists until its original changes, and a rename does not
  // change the original — identical bytes are how it was detected. Carrying it
  // costs no model call and preserves a hand-repaired extraction, which §6.2
  // calls the sanctioned repair path.
  //
  // Every outcome is decided here, in one pass, before any extraction (V).
  // Nothing is written to the manifest yet: a carry that cannot complete simply
  // puts its source on the worklist below, and if that fails too the untouched
  // entry re-presents the whole rename next compile (I).
  const carried = await carryRenames(deps.fs, manifest, discovery.renamed);
  if (carried.wrote) wrote = true;
  const fallbacks = carried.outcomes.filter(
    (outcome): outcome is Extract<CarryOutcome, { kind: "fallback" }> =>
      outcome.kind === "fallback",
  );

  // ── Normalize ──────────────────────────────────────────────────────────
  // Serial, and deliberately so: normalization writes files, and the §11
  // concurrency budget of 2 is for model calls.
  //
  // A rename that could not be carried joins the worklist here. It may
  // overwrite markdown naming its own old path — an extension-only rename
  // lands on the very file it failed to repoint — so its old path is added to
  // the invariant-7 accept list. Nothing else is.
  const acceptOrigins = new Map<string, readonly string[]>(
    fallbacks.map((outcome) => [outcome.rename.source.path, [outcome.rename.from]]),
  );
  // Where each source's markdown already is, so a re-extraction can continue a
  // float rather than fail against a stem somebody else holds (VII). A fallback
  // rename's pointer is filed under the path it came from.
  const recordedDerivatives = new Map<string, string>();
  for (const source of [...discovery.added, ...discovery.modified]) {
    const recorded = manifest[source.path]?.derivative;
    if (recorded !== undefined) recordedDerivatives.set(source.path, recorded);
  }
  for (const outcome of fallbacks) {
    const recorded = manifest[outcome.rename.from]?.derivative;
    if (recorded !== undefined) recordedDerivatives.set(outcome.rename.source.path, recorded);
  }
  const work = [
    ...discovery.added,
    ...discovery.modified,
    ...fallbacks.map((outcome) => outcome.rename.source),
  ].sort((a, b) => comparePaths(a.path, b.path));

  const normalized: NormalizedSource[] = [];
  for (const [index, source] of work.entries()) {
    emit({ phase: "normalizing", path: source.path, index, total: work.length });
    try {
      const outcome = await normalizeSource(
        source.path,
        source.format,
        source.kind,
        normalizeDeps,
        acceptOrigins.get(source.path) ?? [],
        recordedDerivatives.get(source.path),
      );
      normalized.push({
        source,
        hash: outcome.hash,
        readablePath: readablePathFor(source.path, source.format, outcome.derivativePath),
        derivativePath: outcome.derivativePath,
      });
      if (outcome.wrote) wrote = true;
    } catch (error) {
      // Invariant 3: only successes are manifested, so this source is retried
      // next compile. A modified source keeps its previous hash, so it still
      // reads as modified rather than as unchanged; a fallback rename keeps its
      // old path, so it re-presents as the same rename.
      failed.push({ path: source.path, reason: describe(error) });
    }
  }

  // ── Call A ─────────────────────────────────────────────────────────────
  const inventories = new Map<string, SourceInventory>();
  const inventoried = await mapWithConcurrency(
    normalized,
    Math.max(1, deps.settings.compileConcurrency),
    async (entry, index) => {
      emit({ phase: "inventory", path: entry.source.path, index, total: normalized.length });
      try {
        const text = decodeUtf8(await deps.fs.read(entry.readablePath));
        return { ok: true as const, entry, inventory: await takeInventory(provider, bodyOf(text)) };
      } catch (error) {
        return { ok: false as const, entry, reason: describe(error) };
      }
    },
  );

  const ready: NormalizedSource[] = [];
  for (const result of inventoried) {
    if (result.ok) {
      inventories.set(result.entry.source.path, result.inventory);
      ready.push(result.entry);
    } else {
      failed.push({ path: result.entry.source.path, reason: result.reason });
    }
  }

  // ── Renames ────────────────────────────────────────────────────────────
  // §6.2 skips *regeneration* for a rename, not bookkeeping: §4 makes the
  // vault path a source's identity, so every reference to the old path has to
  // follow it. Repointing is a pure text rewrite — no model call — and without
  // it the source page keeps a dead `source:` key, is never found again by the
  // next edit (which then creates a duplicate page), and every citation block
  // naming the old path loses that citer at the next citer union.
  if (discovery.renamed.length > 0) {
    const moved = new Map(
      discovery.renamed.map((rename) => [rename.from, rename.source.path]),
    );
    if (await repointRenames(deps.fs, pages, citations, moved, today)) wrote = true;
    pages = await loadPageTable(deps.fs);
    citations = await readCitations(deps.fs, pages);
  }

  // ── Source pages ───────────────────────────────────────────────────────
  // Assembled by code from Call A's source_summary — no Call B (§6.5).
  //
  // These are named first because §4 requires titles unique across all of
  // wiki/: allocating them before the merge lets the merge see the names they
  // took, so a concept the model happens to name after a filename cannot end
  // up sharing a title with its own source page.
  const toWrite: PageToWrite[] = [];
  const claimed = takenTitles(pages);

  for (const entry of ready) {
    const inventory = inventories.get(entry.source.path) ?? { sourceSummary: "", items: [] };
    const existing = pages.find((page) => page.source === entry.source.path);
    const title = existing?.title ?? uniqueTitle(sanitizeTitle(stem(entry.source.path)), claimed);
    claimed.add(handleOf(title));

    toWrite.push({
      path: existing?.path ?? pagePathForKind(title, "source"),
      title,
      kind: "source",
      aliases: existing?.aliases ?? [],
      summary: inventory.sourceSummary,
      body: inventory.sourceSummary,
      // §4: "A source page's block cites its own raw file."
      citers: [entry.source.path],
      sourcePath: entry.source.path,
    });
  }

  // ── Merge ──────────────────────────────────────────────────────────────
  const entries: SourceInventoryEntry[] = ready.map((entry) => ({
    sourcePath: entry.source.path,
    items: inventories.get(entry.source.path)?.items ?? [],
  }));

  // §6.5: "Also queued: every page citing a modified/deleted source." §6.6's
  // cascade is exactly this queue plus the zero-citer rule below — modification
  // and deletion use one machinery, and one pass over the page table is the
  // visited set, since a page cited twice enters the queue once.
  const deleted = new Set(discovery.deleted);
  const touched = new Set([...discovery.modified.map((source) => source.path), ...deleted]);
  const requeued: string[] = [];
  // Which deleted sources put each page in the queue, so a page that fails to
  // regenerate or delete blocks exactly the sources whose cascade it was.
  const affectedByDeleted = new Map<string, string[]>();

  for (const page of pages) {
    const entries = citations.get(page.path) ?? [];
    if (!entries.some((path) => touched.has(path))) continue;
    requeued.push(page.path);
    const causes = entries.filter((path) => deleted.has(path));
    if (causes.length > 0) affectedByDeleted.set(page.path, causes);
  }

  const workSet = mergeInventories(pages, entries, requeued, claimed);

  // ── Assemble the rest ──────────────────────────────────────────────────
  // A source is manifested only if every page its inventory queued also
  // succeeded, so a failed Call B un-manifests exactly the sources that would
  // have to be re-inventoried to retry it.
  const blockedBy = new Map<string, string[]>();

  // Everything this run knows the readable markdown of (VI). Two sources, not
  // one: normalization writes it, and a *carry* relocates it without
  // normalizing — a carried rename produces no normalize outcome by design, and
  // its new path is an addition, so the manifest as found cannot name it
  // either. Leaving the carry out is how a renamed source became unreadable to
  // Call B while its citation block already named the new path.
  //
  // The two loops write disjoint keys — a rename is carried or falls back, and
  // only a fallback reaches the worklist — so the order settles nothing today.
  // It is written this way so that if the two ever do overlap, the fresher
  // answer is the one that survives.
  const readable = new Map<string, string>();
  for (const outcome of carried.outcomes) {
    if (outcome.kind !== "carried") continue;
    const source = outcome.rename.source;
    readable.set(
      source.path,
      readablePathFor(source.path, source.format, outcome.derivative ?? null),
    );
  }
  for (const entry of normalized) readable.set(entry.source.path, entry.readablePath);
  const bodies = new Map<string, string>();
  const bodyOfSource = async (path: string): Promise<string> => {
    const cached = bodies.get(path);
    if (cached !== undefined) return cached;
    const target = readable.get(path) ?? (await readableFromManifest(deps.fs, manifest, path));
    // §6.5 gives Call B "the full normalized bodies of *all* citing sources".
    // A citer whose markdown cannot be found is not an empty source: passing
    // "" would have the model write a page grounded in a subset while code
    // wrote a citation block claiming the lot, and `wiki/` is rewritten
    // wholesale so the old page would be gone. Failing here instead costs the
    // page one run — the existing text stands and the citers retry.
    if (target === null) throw new UnreadableCiter(path);
    // Reading it can fail too, and a citer whose markdown cannot be read is in
    // exactly the position of one that cannot be found: Call B is not getting
    // that body either way. Letting the raw error out instead would reach the
    // caller unclassified and block every *other* citer of the page.
    let text: string;
    try {
      text = bodyOf(decodeUtf8(await deps.fs.read(target)));
    } catch (error) {
      throw new UnreadableCiter(`${path} — ${describe(error)}`);
    }
    bodies.set(path, text);
    return text;
  };

  // §6.6's "surviving citing sources": the file is still in the vault. Being
  // present is enough — a source that failed to normalize or inventory this run
  // has not gone anywhere, and deleting the page it cites because one run went
  // badly is not recoverable the way retrying an ingest is.
  //
  // `cascadeScope` counts a renamed source's old path live as well, because it
  // runs before `repointRenames`, while every block reaching this point has
  // already been repointed to the new path. The two sets describe the same
  // vault at different moments rather than disagreeing about it.
  //
  // Derived from the manifest this run *found* plus discovery's own sets, not
  // from the one it is about to write: there is no half-built manifest to read
  // any more (I), and the answer must not depend on how far the run has got.
  //
  // `Object.hasOwn`, not `manifested[path] !== undefined`: a hand-written
  // citation entry of `constructor` or `toString` would otherwise resolve to an
  // inherited member of the manifest object and read as a live source forever.
  const present = new Set(
    [...discovery.added, ...discovery.modified, ...discovery.unchanged]
      .map((source) => source.path)
      .concat(discovery.renamed.map((rename) => rename.source.path)),
  );
  const departed = new Set([
    ...discovery.deleted,
    ...discovery.renamed.map((rename) => rename.from),
  ]);
  const isLive = (path: string): boolean =>
    present.has(path) ||
    readable.has(path) ||
    (Object.hasOwn(manifest, path) && !departed.has(path));

  const affected = [
    ...workSet.regenerate.map((item) => ({
      path: item.page.path,
      title: item.page.title,
      kind: item.page.kind,
      aliases: [...item.page.aliases, ...item.newAliases],
      summary: item.newSummary === "" ? item.page.summary : item.newSummary,
      citers: citerUnion(citations.get(item.page.path) ?? [], item.newCiters, isLive),
    })),
    ...workSet.newPages.map((item) => ({
      path: pagePathForKind(item.title, item.kind),
      title: item.title,
      kind: item.kind,
      aliases: item.aliases,
      summary: item.summary,
      citers: citerUnion([], item.citers, isLive),
    })),
  ];

  // §6.6: "a page with zero remaining source citations is deleted". The citer
  // union is what decides it, which is what makes the preview's list a "may":
  // a modified or new source whose inventory named this page again has already
  // added itself above, and the page regenerates instead.
  //
  // This runs before the kind filter on purpose. A deleted source's own source
  // page is caught here by the same rule as any other — its only citation is
  // the raw file that just vanished — so it needs no case of its own.
  //
  // A page this run is writing is never doomed, whatever its old block said.
  // Doomedness is read from the citation block on disk, while a source page is
  // queued from its `source:` key, so a page whose block was edited by hand to
  // name only a dead path would otherwise be written and then deleted in the
  // same run. The write is the authoritative record; it wins.
  const writing = new Set(toWrite.map((page) => page.path));
  const doomed = affected.filter(
    (target) => target.citers.length === 0 && !writing.has(target.path),
  );
  const doomedPaths = new Set(doomed.map((target) => target.path));

  // Entity/concept pages — one Call B each.
  const generationTargets = affected.filter(
    (target) => target.citers.length > 0 && target.kind !== "source",
  );

  const generated = await mapWithConcurrency(
    generationTargets,
    Math.max(1, deps.settings.compileConcurrency),
    async (target, index) => {
      emit({ phase: "generating", title: target.title, index, total: generationTargets.length });
      try {
        const sources = [];
        for (const path of target.citers) {
          sources.push({ path, body: await bodyOfSource(path) });
        }
        const body = await generatePageBody(provider, {
          title: target.title,
          kind: target.kind,
          aliases: target.aliases,
          sources,
          contextBudgetTokens: deps.settings.contextBudgetTokens,
        });
        return { ok: true as const, target, body };
      } catch (error) {
        return {
          ok: false as const,
          target,
          reason: describe(error),
          unreadable: error instanceof UnreadableCiter,
        };
      }
    },
  );

  for (const result of generated) {
    if (result.ok) {
      toWrite.push({ ...result.target, body: result.body });
      continue;
    }
    const reason = `page generation failed for ${result.target.title} — ${result.reason}`;
    // A citer Luka cannot read is not something re-inventorying anyone would
    // fix — the file is in the vault but outside what compile can process, and
    // §6.1 already names it in a skip notice. Blocking the page's *other*
    // citers would leave them unmanifested and re-inventoried on every compile
    // for as long as it sits there. The page keeps the text it has.
    if (result.unreadable) failed.push({ path: result.target.path, reason });
    else for (const citer of result.target.citers) block(blockedBy, citer, reason);
    blockCascade(blockedDeleted, affectedByDeleted, result.target.path, reason);
  }

  // ── Post-process and write ─────────────────────────────────────────────
  // The title index covers existing pages plus everything written this run, so
  // a link to a page created in the same compile resolves immediately.
  // A doomed page is dropped from the table first: it is about to leave the
  // vault, and a link resolved against it would point at nothing. Left in, it
  // would also outrank a live page for a shared alias.
  const index = buildTitleIndex([
    ...pages.filter(
      (page) =>
        !doomedPaths.has(page.path) && !toWrite.some((written) => written.path === page.path),
    ),
    ...toWrite.map(toMeta),
  ]);

  // A page title comes from the model, and `sanitizeTitle` removes only the
  // characters §4 names — not every name a filesystem will refuse (`?`, `*`,
  // a reserved Windows name, or simply one too long for the host). An
  // unguarded write would throw straight out of compile, past the manifest
  // step, discarding the record for every source that succeeded and making the
  // next run re-spend every model call it already paid for. §11's rule is that
  // a failure costs one source, so this degrades the same way.
  let pagesWritten = 0;
  for (const page of toWrite) {
    try {
      const directory = dirname(page.path);
      if (directory !== "") await deps.fs.mkdir(directory);
      await deps.fs.write(page.path, renderPage(page, index, today));
      pagesWritten += 1;
      wrote = true;
    } catch (error) {
      const reason = `could not write ${page.path} — ${describe(error)}`;
      if (page.citers.length === 0) failed.push({ path: page.path, reason });
      for (const citer of page.citers) block(blockedBy, citer, reason);
      blockCascade(blockedDeleted, affectedByDeleted, page.path, reason);
    }
  }

  // ── Delete (§6.6) ──────────────────────────────────────────────────────
  // After the writes and before the index, so the index is re-derived from a
  // page table that no longer contains them. Doomed and written pages are
  // disjoint: entity/concept pages reach `toWrite` only with a live citer, and
  // the source pages already in it were excluded from `doomed` by path.
  let pagesDeleted = 0;
  for (const page of doomed) {
    try {
      await deps.fs.delete(page.path);
      pagesDeleted += 1;
      wrote = true;
    } catch (error) {
      const reason = `could not delete ${page.path} — ${describe(error)}`;
      if (!affectedByDeleted.has(page.path)) failed.push({ path: page.path, reason });
      blockCascade(blockedDeleted, affectedByDeleted, page.path, reason);
    }
  }

  // §6.5 ends every compile by regenerating the index, so it is always
  // re-derived from the page table on disk — never conditioned on whether this
  // run happened to write a page. It is only *written* when the bytes differ,
  // which is what keeps an unchanged vault at zero writes (§6.2).
  const table = await loadPageTable(deps.fs);
  // Nothing to index and no index yet means an empty vault: §6.5's step is
  // vacuous there, and writing a heading-only file would create wiki/ for a
  // user who has never compiled anything.
  if (table.length > 0 || (await deps.fs.exists(INDEX_PATH))) {
    emit({ phase: "writing-index" });
    // Guarded for the same reason the page-write loop above is, and it matters
    // more here: this runs *after* the model calls are spent and the pages are
    // on disk, but *before* the manifest commit. An unguarded throw took the
    // whole run with it — nothing that succeeded was recorded, so the next
    // compile re-spent every call, and a persistently unwritable index (a
    // read-only file, a sync conflict, a directory in its place) made that a
    // loop with no way out and no notice explaining it.
    try {
      const rendered = renderIndex(table);
      if (rendered !== (await readIfPresent(deps.fs, INDEX_PATH))) {
        await deps.fs.mkdir(dirname(INDEX_PATH));
        await deps.fs.write(INDEX_PATH, rendered);
        wrote = true;
      }
    } catch (error) {
      // §6.5 re-derives the index from the page table every compile, so the
      // next run rebuilds it from scratch; nothing has to be remembered. That
      // is the definition of `reported` rather than `failed` — and it matters
      // to what the user is told, because `failed` is rendered as "skipped
      // <path>", and the index is neither a source nor a page.
      reported.push({ path: INDEX_PATH, reason: `could not write the index — ${describe(error)}` });
    }
  }

  // ── Manifest — the single commit point (I) ─────────────────────────────
  // Built here, once, from outcomes that are already complete. Nothing above
  // has touched it, so every failure recovery in this whole compile is the same
  // one thing: the entry that was never rewritten still describes the vault as
  // it was, and §6.2 presents the same work again next run. There is nothing to
  // withdraw, restore, or roll back.
  const next: IngestManifest = { ...manifest };
  const settled = new Map(ready.map((entry) => [entry.source.path, entry]));
  // Locations this run records as some source's markdown. A file standing at
  // one of them is not a leftover, whoever put it there.
  const claimedDerivatives = new Set<string>();
  for (const outcome of carried.outcomes) {
    if (outcome.kind === "carried" && outcome.derivative !== undefined) {
      claimedDerivatives.add(outcome.derivative);
    }
  }
  for (const entry of ready) {
    if (entry.derivativePath !== null) claimedDerivatives.add(entry.derivativePath);
  }

  // A departure is only recorded once its cascade completed. Leaving the path
  // in makes §6.2 see it leave again next compile, which re-runs the cascade
  // idempotently — retry with no extra state, exactly as a failed ingest
  // retries by not being manifested.
  for (const path of discovery.deleted) {
    if (!blockedDeleted.has(path)) delete next[path];
  }

  for (const outcome of carried.outcomes) {
    const rename = outcome.rename;
    const to = rename.source.path;

    if (outcome.kind === "carried") {
      // Deliberately not checking `blockedBy`. A page can fail while naming a
      // carried rename among its citers, but a page is only ever *queued* by a
      // source that was added, modified or deleted — never by a rename, which
      // §6.2 exempts from regeneration. So the source that owes this page is
      // un-manifested in the usual way and brings it back on its own.
      // Withholding the rename as well buys the page nothing it does not
      // already have, and costs the carry: it would leave the old entry naming
      // a path the carry had already vacated, so the retry could not recognise
      // its own work and would re-extract over §6.2's sanctioned repair.
      // Withholding the entry here instead threw away a carry that had already
      // moved the file, leaving the old entry naming a vacated path so the
      // retry could not recognise its own work and re-extracted over §6.2's
      // sanctioned repair.
      delete next[rename.from];
      next[to] = entryFor(rename.source.hash, outcome.derivative);
      // Forward completion: markdown the carry left behind at the old location,
      // now that the source's own copy is settled elsewhere (III).
      const leftover = await removeSupersededDerivative(
        deps.fs,
        rename,
        manifest[rename.from]?.derivative,
        outcome.derivative,
        claimedDerivatives,
      );
      if (leftover.deleted) {
        derivativesDeleted += 1;
        wrote = true;
      }
      if (leftover.report !== null) reported.push(leftover.report);
      continue;
    }

    // A fallback re-extracted instead of carrying, and unlike a carry it *did*
    // reach the worklist — so a page it owes failing means invariant 3 keeps it
    // out of the manifest, exactly as for any other source in `ready`. Nothing
    // is swept either: the run has not finished with it. Its `failed` entry
    // comes from the `ready` loop below, so nothing is added here.
    //
    // Not settled at all means the re-extraction failed too, and that failure
    // is already reported with the promise of a retry — M2d's rule holds, one
    // problem, one notice. Saying separately that the carry fell back would
    // describe a detour that led nowhere.
    const done = settled.get(to);
    if (done === undefined || blockedBy.has(to)) continue;

    delete next[rename.from];
    const leftover = await removeSupersededDerivative(
      deps.fs,
      rename,
      manifest[rename.from]?.derivative,
      done.derivativePath ?? undefined,
      claimedDerivatives,
    );
    if (leftover.deleted) {
      derivativesDeleted += 1;
      wrote = true;
    }
    if (leftover.report !== null) reported.push(leftover.report);
    reported.push({ path: to, reason: outcome.reason });
  }

  for (const entry of ready) {
    const blocked = blockedBy.get(entry.source.path);
    if (blocked !== undefined) {
      failed.push({ path: entry.source.path, reason: blocked.join("; ") });
      continue;
    }
    next[entry.source.path] = entryFor(entry.hash, entry.derivativePath ?? undefined);

    // A float that came home leaves the file it vacated behind. Forward
    // completion of a re-extraction that succeeded, behind the same guard as
    // every other removal (III) — and a no-op for every source that wrote where
    // its entry already pointed, which is all of them but a returning float.
    const previous = manifest[entry.source.path]?.derivative;
    if (previous === undefined) continue;
    const vacated = await removeSupersededDerivative(
      deps.fs,
      { from: entry.source.path, source: entry.source },
      previous,
      entry.derivativePath ?? undefined,
      claimedDerivatives,
    );
    if (vacated.deleted) {
      derivativesDeleted += 1;
      wrote = true;
    }
    if (vacated.report !== null) reported.push(vacated.report);
  }

  // The hash is `CASCADE_PENDING`, never the old one, so the entry cannot pair
  // as a rename against an unrelated file with the same content while it waits.
  // The derivative pointer is kept: that is the file the retry has to sweep.
  for (const path of [...blockedDeleted.keys()].sort(comparePaths)) {
    const previous = manifest[path];
    if (previous === undefined) continue;
    next[path] = entryFor(CASCADE_PENDING, previous.derivative);
    const reasons = blockedDeleted.get(path) ?? [];
    failed.push({ path, reason: [...reasons, "cascade will retry next compile"].join("; ") });
  }

  if (!isSameManifest(manifest, next)) {
    emit({ phase: "writing-manifest" });
    await saveManifest(deps.fs, deps.manifestPath, next);
    wrote = true;
  }

  return {
    added: discovery.added.length,
    modified: discovery.modified.length,
    unchanged: discovery.unchanged.length,
    deleted: discovery.deleted.length,
    renamed: discovery.renamed.length,
    skipped: discovery.skipped,
    failed,
    reported,
    pagesWritten,
    pagesDeleted,
    derivativesDeleted,
    modelCalls,
    noop: !wrote,
    cancelled: false,
  };
}

/** §8.1's declined preview: the diff, and the fact that nothing was done. */
function cancelled(discovery: DiscoveryResult): CompileResult {
  return {
    added: discovery.added.length,
    modified: discovery.modified.length,
    unchanged: discovery.unchanged.length,
    deleted: discovery.deleted.length,
    renamed: discovery.renamed.length,
    skipped: discovery.skipped,
    failed: [],
    reported: [],
    pagesWritten: 0,
    pagesDeleted: 0,
    derivativesDeleted: 0,
    modelCalls: 0,
    noop: true,
    cancelled: true,
  };
}

/**
 * Points every wiki reference at a renamed source's new path, without a model
 * call. Returns whether anything was written.
 *
 * Only the two places code owns are touched: §4's `source:` frontmatter key and
 * the citation block. The model's prose is left exactly as it is — a rename is
 * not a reason to rewrite a page body, and §6.2 says regeneration is skipped.
 */
async function repointRenames(
  fs: FsAdapter,
  pages: readonly PageMeta[],
  citations: ReadonlyMap<string, string[]>,
  moved: ReadonlyMap<string, string>,
  today: string,
): Promise<boolean> {
  let wrote = false;

  for (const page of pages) {
    const entries = citations.get(page.path) ?? [];
    const repointed = entries.map((entry) => moved.get(entry) ?? entry);
    const source = page.source === undefined ? undefined : moved.get(page.source);
    const citersChanged = repointed.some((entry, at) => entry !== entries[at]);
    if (!citersChanged && source === undefined) continue;

    const text = decodeUtf8(await fs.read(page.path));
    const parsed = parseFrontmatter(text);
    const body = parseCitationBlock(parsed.body).rest;

    const data: Record<string, unknown> = { ...parsed.data, updated: today };
    if (source !== undefined) data["source"] = `[[${source}]]`;

    await fs.write(
      page.path,
      serializeFrontmatter(data) + withCitationBlock(body, repointed),
    );
    wrote = true;
  }

  return wrote;
}

/**
 * A page the cascade could not finish with keeps its deleted sources in the
 * manifest, so the deletion is rediscovered and retried next compile.
 */
function blockCascade(
  blocked: Map<string, string[]>,
  affectedByDeleted: ReadonlyMap<string, string[]>,
  pagePath: string,
  reason: string,
): void {
  for (const source of affectedByDeleted.get(pagePath) ?? []) block(blocked, source, reason);
}

/**
 * A manifest entry, with the `derivative` key present only when there is a
 * pointer to record. Entries are built here rather than spread from an older
 * one, so no stale pointer can ride along unnoticed.
 */
function entryFor(hash: string, derivative: string | undefined): ManifestEntry {
  return derivative === undefined ? { hash } : { hash, derivative };
}

/** Records why a source cannot be manifested this run, so it retries next time. */
function block(blockedBy: Map<string, string[]>, citer: string, reason: string): void {
  const reasons = blockedBy.get(citer) ?? [];
  reasons.push(reason);
  blockedBy.set(citer, reasons);
}

function toMeta(page: PageToWrite): PageMeta {
  return {
    path: page.path,
    title: page.title,
    kind: page.kind,
    aliases: page.aliases,
    summary: page.summary,
    updated: "",
    ...(page.sourcePath === undefined ? {} : { source: page.sourcePath }),
  };
}

/**
 * The readable markdown of a source this run did not touch — needed when an
 * unchanged source still cites a page being regenerated (§6.5's "*all* citing
 * sources").
 *
 * The entry names the file, so nothing is guessed. The old version derived a
 * `<stem>.md` candidate from the path, which in a vault holding both
 * `notes.txt` and `notes.md` could hand Call B one document under the other
 * one's label; it also had to stat the source to tell a repo directory from a
 * file, which the recorded pointer makes unnecessary.
 */
async function readableFromManifest(
  fs: FsAdapter,
  manifest: IngestManifest,
  path: string,
): Promise<string | null> {
  // `Object.hasOwn`, not `!== undefined`: a hand-written citation entry of
  // `constructor` or `toString` would otherwise resolve to an inherited member
  // of the manifest object and be read as a manifested source.
  if (!Object.hasOwn(manifest, path)) return null;
  const entry = manifest[path] as ManifestEntry;
  // A pending source has left the vault entirely; there is nothing to read.
  if (isPending(entry)) return null;

  if (entry.derivative === undefined) {
    // Only a passthrough source is its own readable markdown. A *converting*
    // source with no pointer is an entry written before ownership was recorded,
    // so its derivative has not been located — and handing back the source
    // itself would put a PDF's raw bytes in a Call B prompt under its label.
    const format = formatForPath(path);
    if (format === null || !isPassthrough(format)) return null;
    // A file, checked — not assumed. Reading a path that has gone would throw
    // an error no caller classifies as an unreadable citer, and that blocks
    // every *other* citer of the page rather than costing this one. A `stat`
    // that throws is answered the same way, for the same reason.
    try {
      return (await fs.stat(path))?.kind === "file" ? path : null;
    } catch {
      return null;
    }
  }

  // Invariant II: `derived-from` is read as a guard before serving a file as a
  // source's content, never to locate one. Whatever sits at that path, it is
  // not this source's normalized body unless it still says so.
  //
  // A read that fails is answered the same way as one that says "not ours": as
  // "no readable markdown", which costs this page one run. Letting it escape
  // would reach the caller as an unclassified error, which blocks every *other*
  // citer of the page instead.
  try {
    return (await derivativeOrigin(fs, entry.derivative)) === path ? entry.derivative : null;
  } catch {
    return null;
  }
}

/** `null` when the file does not exist, so a comparison can stand in for it. */
async function readIfPresent(fs: FsAdapter, path: string): Promise<string | null> {
  if (!(await fs.exists(path))) return null;
  return decodeUtf8(await fs.read(path));
}


function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
