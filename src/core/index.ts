// The façade the plugin, tests and eval all drive (handoff.md §5).
// At M2d this exposes the full compile — discover → normalize → extract
// (Call A) → generate (Call B) → post-process → index — with §6.6's cascade
// folded through it, plus the scope preview §5 names.
import type { FsAdapter, HttpAdapter } from "./adapters";
import { mapWithConcurrency } from "./concurrency";
import {
  cascadeScope,
  orphanedDerivatives,
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
import { loadManifest, saveManifest } from "./manifest";
import { derivativePathFor, formatForPath, normalizeSource } from "./normalize/index";
import { dirname, stem } from "./paths";
import { createProvider } from "./provider/wrapper";
import type { LLMProvider } from "./provider/types";
import type { IngestManifest, LukaSettings, OperationName, PageMeta } from "./types";
import { parseFrontmatter, serializeFrontmatter } from "./yaml";

export type { FsAdapter, HttpAdapter } from "./adapters";
export { BusyError } from "./lock";
export type { ScopePreview } from "./compile/cascade";
export type { SkippedSource } from "./compile/discover";
export { DEFAULT_SETTINGS } from "./types";
export type { LukaSettings, ProviderTask } from "./types";
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

/** A source that normalized successfully and is ready for Call A. */
interface NormalizedSource {
  source: DiscoveredSource;
  hash: string;
  readablePath: string;
}

async function runCompile(deps: CoreDeps, options: CompileOptions): Promise<CompileResult> {
  const emit = options.onProgress ?? (() => {});
  const provider = deps.provider ?? createProvider({ http: deps.http, settings: deps.settings });
  const before = provider.stats().requests;
  emit({ phase: "discovering" });

  const manifest = await loadManifest(deps.fs, deps.manifestPath);
  const discovery = await discover(deps.fs, manifest);

  // ── Scope preview (§6.6, §8.1) ─────────────────────────────────────────
  // "with scope preview when the diff includes deletions or modifications".
  // This sits inside the lock the façade already holds, so the lock spans
  // preview → confirm → work exactly as §8.1 requires, and a second invocation
  // during the modal gets invariant 2's busy notice.
  if ((discovery.deleted.length > 0 || discovery.modified.length > 0) && options.confirm) {
    const existing = await loadPageTable(deps.fs);
    const preview = cascadeScope(existing, await readCitations(deps.fs, existing), discovery);
    if (!(await options.confirm(preview))) return cancelled(discovery);
  }

  const next: IngestManifest = { ...manifest };
  for (const rename of discovery.renamed) {
    delete next[rename.from];
    next[rename.to] = rename.hash;
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

  // Deleted sources whose cascade could not be completed. Their manifest entry
  // is put back at the end, so §6.2's rule 3 fires again next compile and the
  // cascade retries — the same shape invariant 3 gives a failed ingest.
  const blockedDeleted = new Set<string>();

  // ── Orphaned derivatives ───────────────────────────────────────────────
  // A source that left its path takes its derivative with it: `wiki/` is
  // machine-owned and so is anything Luka wrote into `raw/` (invariant 7).
  // This runs before normalization so a new source with the same stem can
  // claim the freed derivative path in this very run.
  for (const orphan of await orphanedDerivatives(deps.fs, [
    ...discovery.deleted,
    ...discovery.renamed.map((rename) => rename.from),
  ])) {
    try {
      await deps.fs.delete(orphan.derivative);
      wrote = true;
    } catch (error) {
      blockedDeleted.add(orphan.owner);
      failed.push({
        path: orphan.owner,
        reason: `could not delete ${orphan.derivative} — ${describe(error)}`,
      });
    }
  }

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
      });
      if (outcome.wrote) wrote = true;
    } catch (error) {
      // Invariant 3: only successes are manifested, so this source is retried
      // next compile. A modified source keeps its previous hash, so it still
      // reads as modified rather than as unchanged.
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

  let pages = await loadPageTable(deps.fs);
  let citations = await readCitations(deps.fs, pages);

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
    const target = readable.get(path) ?? (await readableFromManifest(deps.fs, path));
    const text = target === null ? "" : bodyOf(decodeUtf8(await deps.fs.read(target)));
    bodies.set(path, text);
    return text;
  };

  // `Object.hasOwn`, not `next[path] !== undefined`: a hand-written citation
  // entry of `constructor` or `toString` would otherwise resolve to an
  // inherited member of the manifest object and read as a live source forever.
  const isLive = (path: string): boolean =>
    Object.hasOwn(next, path) || readable.has(path);

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
  const doomed = affected.filter((target) => target.citers.length === 0);
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
        return { ok: false as const, target, reason: describe(error) };
      }
    },
  );

  for (const result of generated) {
    if (result.ok) {
      toWrite.push({ ...result.target, body: result.body });
      continue;
    }
    // Every source that queued this page must be re-inventoried to retry it.
    const reason = `page generation failed for ${result.target.title} — ${result.reason}`;
    for (const citer of result.target.citers) block(blockedBy, citer, reason);
    blockCascade(blockedDeleted, affectedByDeleted, result.target.path);
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
  for (const page of toWrite) {
    try {
      const directory = dirname(page.path);
      if (directory !== "") await deps.fs.mkdir(directory);
      await deps.fs.write(page.path, renderPage(page, index, today));
      wrote = true;
    } catch (error) {
      const reason = `could not write ${page.path} — ${describe(error)}`;
      if (page.citers.length === 0) failed.push({ path: page.path, reason });
      for (const citer of page.citers) block(blockedBy, citer, reason);
      blockCascade(blockedDeleted, affectedByDeleted, page.path);
    }
  }

  // ── Delete (§6.6) ──────────────────────────────────────────────────────
  // After the writes and before the index, so the index is re-derived from a
  // page table that no longer contains them. A doomed page is never also a
  // written one: every entry in `toWrite` has at least one live citer.
  let pagesDeleted = 0;
  for (const page of doomed) {
    try {
      await deps.fs.delete(page.path);
      pagesDeleted += 1;
      wrote = true;
    } catch (error) {
      failed.push({ path: page.path, reason: `could not delete — ${describe(error)}` });
      blockCascade(blockedDeleted, affectedByDeleted, page.path);
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
  for (const entry of ready) {
    const blocked = blockedBy.get(entry.source.path);
    if (blocked === undefined) {
      next[entry.source.path] = entry.hash;
    } else {
      failed.push({ path: entry.source.path, reason: blocked.join("; ") });
    }
  }

  // A deletion is only recorded once its cascade completed. Putting the entry
  // back makes §6.2 rule 3 (path present, file absent) fire again next compile,
  // which re-runs the cascade idempotently — retry with no extra state, exactly
  // as a failed ingest retries by not being manifested.
  for (const path of discovery.deleted) {
    if (!blockedDeleted.has(path)) continue;
    next[path] = manifest[path] as string;
    failed.push({ path, reason: "cascade incomplete — will retry next compile" });
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
    pagesWritten: toWrite.length,
    pagesDeleted,
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
  blocked: Set<string>,
  affectedByDeleted: ReadonlyMap<string, string[]>,
  pagePath: string,
): void {
  for (const source of affectedByDeleted.get(pagePath) ?? []) blocked.add(source);
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
 * The format decides the answer, so it is read from the path rather than
 * guessed at: a passthrough source IS its own readable markdown, and guessing
 * `<stem>.md` for one would hand back an unrelated neighbour's file — a vault
 * holding both `notes.txt` and `notes.md` would feed the wrong document to
 * Call B under the right document's label. A derivative is accepted only if it
 * names this source as its origin, for the same reason.
 */
async function readableFromManifest(fs: FsAdapter, path: string): Promise<string | null> {
  const format = formatForPath(path);
  const derivative = format === null ? null : derivativePathFor(path, format);

  if (derivative === null) return (await fs.exists(path)) ? path : null;
  if (!(await fs.exists(derivative))) return null;

  const { data } = parseFrontmatter(decodeUtf8(await fs.read(derivative)));
  return data["derived-from"] === path ? derivative : null;
}

/** `null` when the file does not exist, so a comparison can stand in for it. */
async function readIfPresent(fs: FsAdapter, path: string): Promise<string | null> {
  if (!(await fs.exists(path))) return null;
  return decodeUtf8(await fs.read(path));
}

function isSameManifest(a: IngestManifest, b: IngestManifest): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
