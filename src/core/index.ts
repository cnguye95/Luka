// The façade the plugin, tests and eval all drive (handoff.md §5).
// At M2d this exposes the full compile — discover → normalize → extract
// (Call A) → generate (Call B) → post-process → index — with §6.6's cascade
// folded through it, plus the scope preview §5 names.
import type { FsAdapter, HttpAdapter } from "./adapters";
import { mapWithConcurrency } from "./concurrency";
import {
  cascadeScope,
  orphanedDerivatives,
  ownedBy,
  type RenameDerivativeAction,
  type ScopePreview,
} from "./compile/cascade";
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
import { buildTitleIndex } from "./compile/links";
import { mergeInventories, type SourceInventoryEntry } from "./compile/dedup";
import { INDEX_PATH, renderIndex } from "./compile/indexdoc";
import {
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
import { formatForPath, isPassthrough, normalizeSource } from "./normalize/index";
import { comparePaths, dirname, stem } from "./paths";
import { createProvider } from "./provider/wrapper";
import type { LLMProvider } from "./provider/types";
import type {
  IngestManifest,
  LukaSettings,
  ManifestEntry,
  OperationName,
  PageMeta,
} from "./types";
import { parseFrontmatter, replaceFrontmatterValue, serializeFrontmatter } from "./yaml";

export type { FsAdapter, HttpAdapter } from "./adapters";
export { BusyError } from "./lock";
export type { ScopePreview } from "./compile/cascade";
export type { SkippedSource } from "./compile/discover";
export { DEFAULT_SETTINGS } from "./types";
export type { IngestManifest, LukaSettings, ManifestEntry, ProviderTask } from "./types";
// §7.1's node set — "every manifest source's readable markdown" — is exactly
// this value per entry. Exported here rather than from manifest.ts so callers
// outside core keep going through the one façade.
export { readablePathOf } from "./manifest";
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

export interface Core {
  compile(options?: CompileOptions): Promise<CompileResult>;
  /** §5's read-only scope preview: no lock, no model call, no write. */
  previewCompile(): Promise<ScopePreview>;
  readonly busyWith: OperationName | null;
}

export function createCore(deps: CoreDeps): Core {
  const lock = new OperationLock();
  return {
    compile: (options: CompileOptions = {}) => lock.run("compile", () => runCompile(deps, options)),
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

/** §5's `previewCompile`. Every step here reads; none of them writes. */
async function runPreview(deps: CoreDeps): Promise<ScopePreview> {
  const manifest = await loadManifest(deps.fs, deps.manifestPath);
  const discovery = await discover(deps.fs, manifest);
  const pages = await loadPageTable(deps.fs);
  return cascadeScope(pages, await readCitations(deps.fs, pages), discovery);
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

async function runCompile(deps: CoreDeps, options: CompileOptions): Promise<CompileResult> {
  const emit = options.onProgress ?? (() => {});
  const provider = deps.provider ?? createProvider({ http: deps.http, settings: deps.settings });
  const before = provider.stats().requests;
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

  const next: IngestManifest = { ...manifest };
  for (const rename of discovery.renamed) {
    // The hash is `rename.hash` by definition — that is how the rename was
    // detected — and the pointer is wherever this run's carry leaves the file,
    // which discovery's classification already decided.
    delete next[rename.from];
    next[rename.to] = entryFor(rename.hash, carriedDerivative(rename.derivative));
  }
  for (const path of discovery.deleted) delete next[path];

  const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  const normalizeDeps = {
    fs: deps.fs,
    http: deps.http,
    timeoutMs: deps.settings.requestTimeoutMs,
    today,
    provider,
  };

  const work = [...discovery.added, ...discovery.modified];
  const failed: CompileFailure[] = [];
  let wrote = false;

  // Departed sources whose cascade could not be completed, and why. Their
  // manifest entry is put back at the end, so §6.2's rules see the path leave
  // again next compile and the cascade retries — the same shape invariant 3
  // gives a failed ingest.
  const blockedDeleted = new Map<string, string[]>();

  // ── Orphaned derivatives ───────────────────────────────────────────────
  // A source that left its path takes its derivative with it: `wiki/` is
  // machine-owned and so is anything Luka wrote into `raw/` (invariant 7).
  // This runs before normalization so a new source with the same stem can
  // claim the freed derivative path in this very run.
  // A renamed source keeps its derivative rather than rebuilding it: §6.2 says
  // a derivative persists until its original changes, and a rename does not
  // change the original — identical bytes are how it was detected. Carrying it
  // over costs no model call and preserves a hand-repaired extraction, which
  // §6.2 calls the sanctioned repair path. Discovery used this same decision
  // to conclude the source needs no reprocessing, so the two cannot disagree.
  //
  // Before normalization, so a source that does have to re-extract finds its
  // derivative path settled.
  // Old paths whose derivative must survive this pass: either a carry-over
  // failed and the retry still needs it, or the source is re-extracting and
  // the replacement does not exist yet.
  const deferSweep = new Set<string>();
  for (const rename of discovery.renamed) {
    const action = rename.derivative;
    // A re-extracting rename keeps its old derivative until the replacement is
    // actually written. Sweeping first destroys a hand repair on behalf of an
    // extraction that may be refused outright — a stem collision at the
    // destination is exactly why this rename fell back to re-extracting.
    if (action.kind === "reprocess") deferSweep.add(rename.from);
    if (action.kind === "none" || action.kind === "reprocess") continue;
    const at = action.kind === "move" ? action.to : action.at;
    const cameFrom = action.kind === "move" ? action.from : null;
    let moved = false;
    try {
      if (cameFrom !== null) {
        await deps.fs.move(cameFrom, at);
        moved = true;
      }
      await repointDerivative(deps.fs, at, rename.to);
      wrote = true;
    } catch (error) {
      // Roll the move back, so a failure leaves the vault exactly as it found
      // it. A file that moved but was not repointed is unreachable: the sweep
      // looks for it at the *old* location, and the retry only re-presents the
      // rename while the source's bytes are unchanged — so an ordinary edit in
      // between would strand it, blocking that derivative path for good.
      if (moved && cameFrom !== null) {
        try {
          await deps.fs.move(at, cameFrom);
          moved = false;
        } catch {
          // Rolling back failed too. Removing the stranded file costs the
          // repair but keeps the source ingestable, which is the better of two
          // bad outcomes; if that fails as well, the failure below is reported
          // on every run rather than passing silently.
          try {
            await deps.fs.delete(at);
          } catch {
            // Reported below.
          }
        }
      }
      failed.push({
        path: rename.to,
        reason: `could not carry over ${at} — ${describe(error)}`,
      });
      // Rolled back, the derivative is where it started and still names the old
      // path — which is what lets the next compile recognise the same rename
      // and finish the job. Deleting it as a "recovery" would destroy the
      // repair the retry exists to preserve; a rename is retryable in a way a
      // re-extraction is not.
      //
      // Withdrawing the new path's manifest entry and restoring the old one is
      // what re-presents the rename: without it the file reads as a plain
      // addition next run and gets re-extracted over.
      delete next[rename.to];
      next[rename.from] = manifest[rename.from] ?? { hash: rename.hash };
      // Its derivative, wherever it ended up, is not this run's to sweep:
      // deleting it would destroy the repair that retry could still carry.
      deferSweep.add(rename.from);
    }
  }

  // No shield by path is needed, and an earlier one by path was actively
  // harmful. The sweep deletes a file only when its `derived-from` still names
  // the departed source — and the carry-over above has already repointed every
  // file a living source is taking over, so those no longer name it. What is
  // left really is orphaned, including at a location some other source would
  // like to claim: freeing it is the point.
  let derivativesDeleted = 0;
  const sweep = async (oldPaths: readonly string[]): Promise<void> => {
    for (const orphan of await orphanedDerivatives(deps.fs, oldPaths)) {
      try {
        await deps.fs.delete(orphan.derivative);
        derivativesDeleted += 1;
        wrote = true;
      } catch (error) {
        block(
          blockedDeleted,
          orphan.owner,
          `could not delete ${orphan.derivative} — ${describe(error)}`,
        );
      }
    }
  };

  await sweep(
    [...discovery.deleted, ...discovery.renamed.map((rename) => rename.from)].filter(
      (path) => !deferSweep.has(path),
    ),
  );

  // ── Normalize ──────────────────────────────────────────────────────────
  // Serial, and deliberately so: normalization writes files, and the §11
  // concurrency budget of 2 is for model calls.
  const normalized: NormalizedSource[] = [];
  for (const [index, source] of work.entries()) {
    emit({ phase: "normalizing", path: source.path, index, total: work.length });
    try {
      const outcome = await normalizeSource(source.path, source.format, source.kind, normalizeDeps);
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
      // reads as modified rather than as unchanged.
      failed.push({ path: source.path, reason: describe(error) });
    }
  }

  // Now the replacements exist, the deferred orphans really are orphans. A
  // rename whose re-extraction failed keeps its old derivative for the retry
  // to carry — losing a repair is not a price a failure should exact.
  const extracted = new Set(normalized.map((entry) => entry.source.path));
  await sweep(
    discovery.renamed
      .filter((rename) => deferSweep.has(rename.from) && extracted.has(rename.to))
      .map((rename) => rename.from),
  );

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
    const moved = new Map(discovery.renamed.map((rename) => [rename.from, rename.to]));
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
    claimed.add(title.toLowerCase());

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

  const readable = new Map(ready.map((entry) => [entry.source.path, entry.readablePath]));
  const bodies = new Map<string, string>();
  const bodyOfSource = async (path: string): Promise<string> => {
    const cached = bodies.get(path);
    if (cached !== undefined) return cached;
    const target = readable.get(path) ?? (await readableFromManifest(deps.fs, next, path));
    // §6.5 gives Call B "the full normalized bodies of *all* citing sources".
    // A citer whose markdown cannot be found is not an empty source: passing
    // "" would have the model write a page grounded in a subset while code
    // wrote a citation block claiming the lot, and `wiki/` is rewritten
    // wholesale so the old page would be gone. Failing here instead costs the
    // page one run — the existing text stands and the citers retry.
    if (target === null) throw new UnreadableCiter(path);
    const text = bodyOf(decodeUtf8(await deps.fs.read(target)));
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
  // `Object.hasOwn`, not `next[path] !== undefined`: a hand-written citation
  // entry of `constructor` or `toString` would otherwise resolve to an
  // inherited member of the manifest object and read as a live source forever.
  const present = new Set(
    [...discovery.added, ...discovery.modified, ...discovery.unchanged]
      .map((source) => source.path)
      .concat(discovery.renamed.map((rename) => rename.to)),
  );
  const isLive = (path: string): boolean =>
    present.has(path) || Object.hasOwn(next, path) || readable.has(path);

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
    const rendered = renderIndex(table);
    if (rendered !== (await readIfPresent(deps.fs, INDEX_PATH))) {
      await deps.fs.mkdir(dirname(INDEX_PATH));
      await deps.fs.write(INDEX_PATH, rendered);
      wrote = true;
    }
  }

  // ── Manifest ───────────────────────────────────────────────────────────
  // The rename pass above recorded the new path unconditionally, because a
  // rename on its own needs no processing. When the same source was *also*
  // modified — its derivative did not come along — that entry is a claim the
  // run has not earned, so a failure has to take it back out (invariant 3).
  const succeeded = new Set(ready.map((entry) => entry.source.path));
  for (const rename of discovery.renamed) {
    const alsoModified = discovery.modified.some((source) => source.path === rename.to);
    if (!alsoModified || succeeded.has(rename.to)) continue;
    delete next[rename.to];
    // The re-extraction failed, so its old derivative is still deferred and
    // still on disk. Restoring the old path keeps the rename in front of the
    // next compile, which keeps that deferral justified and the failure
    // reported — otherwise the file is stranded with nothing able to reach it
    // and nothing saying why.
    if (rename.derivative.kind === "reprocess") {
      next[rename.from] = manifest[rename.from] ?? { hash: rename.hash };
    }
  }

  for (const entry of ready) {
    const blocked = blockedBy.get(entry.source.path);
    if (blocked === undefined) {
      next[entry.source.path] = entryFor(entry.hash, entry.derivativePath ?? undefined);
    } else {
      failed.push({ path: entry.source.path, reason: blocked.join("; ") });
    }
  }

  // A departure is only recorded once its cascade completed. Re-entering the
  // path makes §6.2 see it leave again next compile, which re-runs the cascade
  // idempotently — retry with no extra state, exactly as a failed ingest
  // retries by not being manifested.
  //
  // This covers the old side of a rename as well as an outright deletion: that
  // path is a manifest key too, which is how the rename was detected, and its
  // stale derivative is swept by the same pass.
  //
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
    pagesWritten,
    pagesDeleted,
    derivativesDeleted,
    modelCalls: provider.stats().requests - before,
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
 * Points a carried-over derivative at its source's new path, touching only that
 * one line. A user may have repaired this file by hand (§6.2), so the rest of
 * their frontmatter — comments, key order, scalar styles — is left alone; a
 * full re-serialize would restyle all of it for the sake of one value.
 */
async function repointDerivative(fs: FsAdapter, path: string, to: string): Promise<void> {
  const text = decodeUtf8(await fs.read(path));
  const rewritten = replaceFrontmatterValue(text, "derived-from", to);
  // `null` means the key could not be rewritten safely — a nested key of the
  // same name, a folded value, a quoted key. Treating that as success would
  // leave the file naming a path that no longer exists, which fails the source
  // on every later run; the caller's recovery handles it instead.
  if (rewritten === null) throw new Error(`could not repoint derived-from in ${path}`);
  if (rewritten !== text) await fs.write(path, rewritten);
}

/**
 * A manifest entry, with the `derivative` key present only when there is a
 * pointer to record. Entries are built here rather than spread from an older
 * one, so no stale pointer can ride along unnoticed.
 */
function entryFor(hash: string, derivative: string | undefined): ManifestEntry {
  return derivative === undefined ? { hash } : { hash, derivative };
}

/**
 * Where a renamed source's derivative will be once this run's carry lands —
 * discovery's classification, read for its destination rather than re-derived.
 *
 * A re-extracting rename records no pointer: the replacement does not exist
 * yet, so a run that fails after this point must leave an entry that still
 * reads as a source owed a derivative. `none` is a passthrough source, which
 * owes none at all.
 */
function carriedDerivative(action: RenameDerivativeAction): string | undefined {
  switch (action.kind) {
    case "repoint":
      return action.at;
    case "move":
      return action.to;
    case "none":
    case "reprocess":
      return undefined;
  }
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
    return format !== null && isPassthrough(format) ? path : null;
  }

  // Invariant II: `derived-from` is read as a guard before serving a file as a
  // source's content, never to locate one. Whatever sits at that path, it is
  // not this source's normalized body unless it still says so.
  return (await ownedBy(fs, entry.derivative, path)) ? entry.derivative : null;
}

/** `null` when the file does not exist, so a comparison can stand in for it. */
async function readIfPresent(fs: FsAdapter, path: string): Promise<string | null> {
  if (!(await fs.exists(path))) return null;
  return decodeUtf8(await fs.read(path));
}


function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
