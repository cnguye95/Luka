// The façade the plugin, tests and eval all drive (handoff.md §5).
// At M1 this exposes compile's ingest half only; extraction and generation
// arrive in M2.
import type { FsAdapter, HttpAdapter } from "./adapters";
import { discover, type SkippedSource } from "./compile/discover";
import { OperationLock } from "./lock";
import { loadManifest, saveManifest } from "./manifest";
import { normalizeSource } from "./normalize/index";
import type { IngestManifest, LukaSettings, OperationName } from "./types";

export type { FsAdapter, HttpAdapter } from "./adapters";
export { BusyError } from "./lock";
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
  /** True when the run wrote nothing at all. */
  noop: boolean;
}

export type ProgressEvent =
  | { phase: "discovering" }
  | { phase: "normalizing"; path: string; index: number; total: number }
  | { phase: "writing-manifest" };

export interface CompileOptions {
  onProgress?: (event: ProgressEvent) => void;
}

export interface Core {
  compile(options?: CompileOptions): Promise<CompileResult>;
  readonly busyWith: OperationName | null;
}

export function createCore(deps: CoreDeps): Core {
  const lock = new OperationLock();
  return {
    compile: (options: CompileOptions = {}) => lock.run("compile", () => runCompile(deps, options)),
    get busyWith(): OperationName | null {
      return lock.busyWith;
    },
  };
}

async function runCompile(deps: CoreDeps, options: CompileOptions): Promise<CompileResult> {
  const emit = options.onProgress ?? (() => {});
  emit({ phase: "discovering" });

  const manifest = await loadManifest(deps.fs, deps.manifestPath);
  const discovery = await discover(deps.fs, manifest);

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
  };

  const work = [...discovery.added, ...discovery.modified];
  const failed: CompileFailure[] = [];
  let wrote = false;

  for (const [index, source] of work.entries()) {
    emit({ phase: "normalizing", path: source.path, index, total: work.length });
    try {
      const outcome = await normalizeSource(
        source.path,
        source.format,
        source.kind,
        normalizeDeps,
      );
      next[source.path] = outcome.hash;
      if (outcome.wrote) wrote = true;
    } catch (error) {
      // Invariant 3: only successes are manifested, so this source is retried
      // next compile. A modified source keeps its previous hash, so it still
      // reads as modified rather than as unchanged.
      failed.push({ path: source.path, reason: describe(error) });
    }
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
    noop: !wrote,
  };
}

function isSameManifest(a: IngestManifest, b: IngestManifest): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
