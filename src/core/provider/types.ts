// Provider layer types (handoff.md §11).
//
// Two layers, deliberately separated: `RawProvider` is transport — it speaks
// one vendor's API over the injected HttpAdapter and knows nothing about
// tasks, retries, or JSON. `LLMProvider` is what the rest of core calls; it is
// produced by the reliability wrapper, and invariant 10 holds because the
// wrapper is the only thing that ever talks to a RawProvider.
import type { ProviderTask } from "../types";

export interface ProviderImage {
  /** e.g. `image/png` — becomes the content block's media_type. */
  mediaType: string;
  data: Uint8Array;
}

/** §11's signature, plus `images` — the vision task cannot exist without it. */
export interface CompletionRequest {
  task: ProviderTask;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  images?: ProviderImage[];
}

/** What the wrapper hands to transport: model resolved, cap applied. */
export interface RawRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  images?: ProviderImage[];
  timeoutMs: number;
}

export interface RawProvider {
  /** Resolves with the reply text; throws ProviderError for HTTP-level failures. */
  complete(request: RawRequest): Promise<string>;
}

export interface ProviderStats {
  /** Every transport attempt, including retries and the JSON repair call. */
  requests: number;
  byTask: Record<ProviderTask, number>;
}

export interface LLMProvider {
  complete(request: CompletionRequest & { json: true }): Promise<unknown>;
  complete(request: CompletionRequest & { json?: false }): Promise<string>;
  stats(): ProviderStats;
}

export class ProviderError extends Error {
  readonly task?: ProviderTask;
  readonly status?: number;
  readonly retryable: boolean;
  /** Parsed from a Retry-After header, when the vendor sent one. */
  readonly retryAfterMs?: number;
  /**
   * The vendor's message as it arrived, unclipped. `message` carries a clipped
   * copy of it because that one reaches a Notice; anything that *decides* on
   * the text reads this instead, so a bound written for display cannot change
   * behaviour.
   */
  readonly vendorMessage?: string;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      task?: ProviderTask;
      status?: number;
      retryAfterMs?: number;
      vendorMessage?: string;
    },
  ) {
    super(message);
    this.name = "ProviderError";
    this.retryable = options.retryable;
    if (options.task !== undefined) this.task = options.task;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.vendorMessage !== undefined) this.vendorMessage = options.vendorMessage;
  }
}

/** §11's per-task max_tokens caps. Fixed by the spec, not settings. */
export const MAX_TOKENS_BY_TASK: Record<ProviderTask, number> = {
  inventory: 2000,
  "seed-selection": 500,
  "page-generation": 3000,
  synthesis: 4000,
  vision: 1500,
};
