// Shared types for src/core. Nothing here may import `obsidian` (invariant 6).

export type PageKind = "source" | "entity" | "concept";

/** handoff.md §4 frontmatter key `source-format`. */
export type SourceFormat = "md" | "txt" | "html" | "pdf" | "repo" | "dataset" | "image";

/** handoff.md §11 provider tasks. */
export type ProviderTask =
  | "inventory"
  | "page-generation"
  | "seed-selection"
  | "synthesis"
  | "vision";

export const PROVIDER_TASKS: readonly ProviderTask[] = [
  "inventory",
  "page-generation",
  "seed-selection",
  "synthesis",
  "vision",
] as const;

/** handoff.md §7.3. */
export type RetrievalMode = "A" | "B";

/** A wiki page as reconstructed from its frontmatter (handoff.md §4). */
export interface PageMeta {
  path: string;
  title: string;
  kind: PageKind;
  aliases: string[];
  summary: string;
  updated: string;
  /**
   * Source pages only: the vault path of the raw file this page describes,
   * unwrapped from §4's `source: "[[raw/<file>]]"` frontmatter. It is how a
   * re-ingested source finds its existing page and keeps its title stable.
   */
  source?: string;
}

export interface GraphNode {
  path: string;
  title: string;
  /** `raw` marks a manifest source node rather than a wiki page (handoff.md §7.1). */
  kind: PageKind | "raw";
  degree: number;
  /**
   * §4's one-line summary, carried so §9's hover tooltip (title, kind, summary)
   * needs no second read of the vault. A raw source node has no frontmatter to
   * summarize and carries `""`.
   */
  summary: string;
}

export interface GraphEdge {
  a: string;
  b: string;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * What one source's last successful ingest produced.
 *
 * §3 describes the manifest as "path → SHA-256 content hash"; the entry records
 * the derivative alongside it, because the hash cannot say which file in `raw/`
 * this source's extraction wrote — and inferring that from the filename every
 * compile is the root of the M2d defect cluster (BUILD-NOTES "M2e").
 *
 * `hash` is deliberately not always a hash: `CASCADE_PENDING` marks a source
 * that left the vault but whose §6.6 cascade could not be completed. Readers
 * that treat an entry as "this file exists and is ingested" — §7.1's graph node
 * set and §10's health check — must skip those; `readablePathOf` does it for
 * them.
 *
 * Entries are immutable: a changed entry is always a fresh object, so the
 * before/after manifests a run compares can never alias each other.
 */
export interface ManifestEntry {
  readonly hash: string;
  /** Vault path of the derivative Luka wrote; absent for passthrough sources. */
  readonly derivative?: string;
}

/** Vault-relative source path → its ingest record (handoff.md §3, §6.2). */
export type IngestManifest = Record<string, ManifestEntry>;

/** Names of the operations that contend for the single global lock (invariant 2). */
export type OperationName = "compile" | "ask" | "health check";

export interface LukaSettings {
  apiKey: string;
  models: Record<ProviderTask, string>;
  contextBudgetTokens: number;
  /** K: assembly cap (handoff.md §7.4 step 4). */
  assemblyCap: number;
  /** Mode predicate pair (handoff.md §7.3). */
  modeMinNodes: number;
  modeMinLinkRatio: number;
  followUpEnabled: boolean;
  pprAlpha: number;
  pprMaxIterations: number;
  seedsCap: number;
  keywordsCap: number;
  requestTimeoutMs: number;
  maxRetries: number;
  compileConcurrency: number;
}

/** handoff.md §17. Values marked "fixed" there are constants in their own modules, not settings. */
export const DEFAULT_SETTINGS: LukaSettings = {
  apiKey: "",
  models: {
    inventory: "claude-haiku-4-5-20251001",
    "seed-selection": "claude-haiku-4-5-20251001",
    "page-generation": "claude-sonnet-5",
    synthesis: "claude-sonnet-5",
    vision: "claude-sonnet-5",
  },
  contextBudgetTokens: 40_000,
  assemblyCap: 12,
  modeMinNodes: 20,
  modeMinLinkRatio: 1.5,
  followUpEnabled: true,
  pprAlpha: 0.85,
  pprMaxIterations: 100,
  seedsCap: 8,
  keywordsCap: 12,
  requestTimeoutMs: 120_000,
  maxRetries: 2,
  compileConcurrency: 2,
};

/**
 * §17's numeric settings, made safe to act on.
 *
 * `data.json` is a file a user can edit and `loadSettings` validates nothing,
 * so every number here can arrive as a string, a NaN, a negative, or an
 * Infinity. The rule is one rule: a value the code cannot act on falls back to
 * §17's default, and a value with a range is clamped into it. Applied once, at
 * the two places settings enter core, rather than at each consumer — the
 * retry budget was clamped at its consumer and the three settings beside it
 * were not, which is how a budget of 0 came to rewrite pages with no source in
 * context while their citation blocks still named one.
 *
 * Idempotent: normalizing an already-normal settings object returns it
 * unchanged, so the two entry points may both call it.
 */
export function normalizeSettings(settings: LukaSettings): LukaSettings {
  return {
    ...settings,
    // `models` is copied, not shared. A spread is shallow, so the nested object
    // stayed live — and the settings tab writes into it on every keystroke, so
    // a run in flight could send a half-typed model id to the vendor. Copying
    // it is what makes "one settings state for the whole run" true rather than
    // true of four values out of five.
    models: { ...settings.models },
    contextBudgetTokens: positive(settings.contextBudgetTokens, DEFAULT_SETTINGS.contextBudgetTokens),
    requestTimeoutMs: positive(settings.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs),
    compileConcurrency: clamp(
      settings.compileConcurrency,
      1,
      MAX_COMPILE_CONCURRENCY,
      DEFAULT_SETTINGS.compileConcurrency,
    ),
    maxRetries: clamp(settings.maxRetries, 0, MAX_RETRY_BUDGET, DEFAULT_SETTINGS.maxRetries),
    // §7.2's damping. Outside (0,1) the iteration stops being a contraction —
    // at 1 it never teleports and at 0 it never walks — so a hand-edited value
    // falls back rather than being clamped to a boundary that means neither.
    pprAlpha: fraction(settings.pprAlpha, DEFAULT_SETTINGS.pprAlpha),
    // §8.2's follow-up toggle. A non-boolean in `data.json` is not a decision
    // either way, so it takes §17's default rather than JavaScript's idea of
    // whether the value is truthy.
    followUpEnabled:
      typeof settings.followUpEnabled === "boolean"
        ? settings.followUpEnabled
        : DEFAULT_SETTINGS.followUpEnabled,
    // §7.3's predicate and §7.4's caps. A node count or ratio below zero makes
    // the predicate meaningless rather than merely strict, and a cap below one
    // asks the model for nothing at all.
    modeMinNodes: clamp(settings.modeMinNodes, 0, 1_000_000, DEFAULT_SETTINGS.modeMinNodes),
    modeMinLinkRatio: atLeastZero(settings.modeMinLinkRatio, DEFAULT_SETTINGS.modeMinLinkRatio),
    seedsCap: clamp(settings.seedsCap, 1, MAX_LIST_CAP, DEFAULT_SETTINGS.seedsCap),
    keywordsCap: clamp(settings.keywordsCap, 1, MAX_LIST_CAP, DEFAULT_SETTINGS.keywordsCap),
    assemblyCap: clamp(settings.assemblyCap, 1, MAX_LIST_CAP, DEFAULT_SETTINGS.assemblyCap),
    pprMaxIterations: clamp(
      settings.pprMaxIterations,
      1,
      MAX_PPR_ITERATIONS,
      DEFAULT_SETTINGS.pprMaxIterations,
    ),
  };
}

/** A ceiling on a hand-edited retry count, so one call cannot hold the lock all day. */
export const MAX_RETRY_BUDGET = 10;
/**
 * §11 budgets concurrency at 2. A raised value is the user's call; an
 * unbounded one is not, because every extra worker is another request holding
 * the operation lock.
 */
export const MAX_COMPILE_CONCURRENCY = 16;
/**
 * A ceiling on a hand-edited iteration count. §7.2's own limit is 100; the
 * ceiling only stops a mistyped one from holding the operation lock while it
 * iterates a converged vector.
 */
export const MAX_PPR_ITERATIONS = 1000;
/**
 * A ceiling on the hand-editable list caps — seeds, keywords, and §7.4's K.
 * Each one bounds work that is paid for per item: a seed is a PPR
 * personalization entry, a keyword is a pass over every page's body, and K is a
 * whole file read into the context budget.
 */
export const MAX_LIST_CAP = 100;

/** Finite and above zero, or §17's default — there is no useful smaller value. */
function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Finite and not negative, or §17's default. */
function atLeastZero(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Finite and strictly between 0 and 1, or §17's default. */
function fraction(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

function clamp(value: number, low: number, high: number, fallback: number): number {
  // The fallback is §17's default, not the range floor. `"compileConcurrency":
  // "4"` — a quoted number, the likeliest hand-edit of all — is not finite, and
  // falling back to the floor would silently answer 1 for it.
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), low), high);
}

/** handoff.md §17, marked fixed: PPR convergence threshold is not user-tunable. */
export const PPR_EPSILON = 1e-8;
