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
}

export interface GraphEdge {
  a: string;
  b: string;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Vault-relative path → SHA-256 of the source's content (handoff.md §3, §6.2). */
export type IngestManifest = Record<string, string>;

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

/** handoff.md §17, marked fixed: PPR convergence threshold is not user-tunable. */
export const PPR_EPSILON = 1e-8;
