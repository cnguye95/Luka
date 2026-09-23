// The model stub, injected at the transport layer so a test runs through the
// real wrapper — its retry budget, JSON repair and call counter included.
// Also the two transport errors and the Call A reply shape tests hand back.
import { createProvider } from "../../src/core/provider/wrapper";
import {
  ProviderError,
  type CompletionRequest,
  type LLMProvider,
  type ProviderStats,
  type RawProvider,
  type RawRequest,
} from "../../src/core/provider/types";
import { DEFAULT_SETTINGS, PROVIDER_TASKS, type ProviderTask } from "../../src/core/types";

export interface RecordedCall {
  task: ProviderTask;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature: number | undefined;
  images: { mediaType: string; bytes: Uint8Array }[];
}

/**
 * What a test hands back for one call: an object or array is serialized as the
 * JSON a real model would emit, a string is returned verbatim (so a test can
 * produce a fenced block or trailing prose), and an Error is thrown from
 * transport the way a failing HTTP call would be.
 */
export type StubReply = unknown;

/**
 * A stub at the **transport** layer, driven through the real wrapper.
 *
 * The layering matters. An earlier version of this helper implemented
 * `LLMProvider` directly, which put it *above* JSON parsing, the repair retry,
 * the retry budget, the per-task max_tokens caps, and `ProviderError` — so
 * invariant 12's call-count assertions were checked against a counter
 * structurally incapable of the inflation the real provider shows, and every
 * failure test threw a bare `Error` the production path never produces.
 *
 * Sitting under the wrapper instead means tests exercise all of it for real.
 */
export class StubProvider implements LLMProvider {
  readonly calls: RecordedCall[] = [];
  private readonly provider: LLMProvider;
  private readonly modelToTask = new Map<string, ProviderTask>();

  constructor(
    reply: (request: CompletionRequest, index: number) => StubReply = () => "",
    options: { maxRetries?: number } = {},
  ) {
    // Each task gets a distinct model id so transport can recover which task it
    // is serving — the wrapper deliberately does not pass the task down.
    const models = Object.fromEntries(
      PROVIDER_TASKS.map((task) => [task, `stub-${task}`]),
    ) as Record<ProviderTask, string>;
    for (const task of PROVIDER_TASKS) this.modelToTask.set(models[task], task);

    const perTask = Object.fromEntries(PROVIDER_TASKS.map((task) => [task, 0])) as Record<
      ProviderTask,
      number
    >;

    const raw: RawProvider = {
      complete: async (request: RawRequest): Promise<string> => {
        const task = this.modelToTask.get(request.model) as ProviderTask;
        this.calls.push({
          task,
          model: request.model,
          system: request.system,
          user: request.user,
          maxTokens: request.maxTokens,
          temperature: request.temperature,
          images: (request.images ?? []).map((image) => ({
            mediaType: image.mediaType,
            bytes: image.data,
          })),
        });

        const index = perTask[task]++;
        const settled = reply(
          {
            task,
            system: request.system,
            user: request.user,
            maxTokens: request.maxTokens,
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.images === undefined ? {} : { images: request.images }),
          },
          index,
        );

        // Awaited, so a test can return a promise and observe how many calls
        // the pipeline keeps in flight (compile concurrency).
        const value = await settled;
        if (value instanceof Error) throw value;
        if (typeof value === "string") return value;
        // Anything else is serialized, so `json: true` callers exercise the
        // wrapper's real JSON.parse rather than receiving a live object.
        return JSON.stringify(value);
      },
    };

    this.provider = createProvider({
      // The transport stub is injected, so no HttpAdapter is ever reached.
      http: {
        request: () => {
          throw new Error("StubProvider must not reach the HTTP adapter");
        },
      },
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: "test-key",
        models,
        maxRetries: options.maxRetries ?? 0,
      },
      raw,
      // Retries are instant in tests.
      sleep: async () => {},
      random: () => 0.5,
    });
  }

  complete(request: CompletionRequest & { json: true }): Promise<unknown>;
  complete(request: CompletionRequest & { json?: false }): Promise<string>;
  complete(request: CompletionRequest): Promise<unknown> {
    return (this.provider.complete as (r: CompletionRequest) => Promise<unknown>)(request);
  }

  stats(): ProviderStats {
    return this.provider.stats();
  }

  callsFor(task: ProviderTask): RecordedCall[] {
    return this.calls.filter((call) => call.task === task);
  }
}

/** A transport failure the wrapper treats as non-retryable, like a real 400. */
export function fatalError(message: string): ProviderError {
  return new ProviderError(message, { retryable: false, status: 400 });
}

/** A transport failure the wrapper retries, like a real 503. */
export function retryableError(message: string): ProviderError {
  return new ProviderError(message, { retryable: true, status: 503 });
}

/** The Call A reply shape, as the model would return it. */
export function inventoryReply(
  sourceSummary: string,
  items: {
    title: string;
    kind: "entity" | "concept";
    aliases?: string[];
    summary?: string;
  }[] = [],
): Record<string, unknown> {
  return {
    source_summary: sourceSummary,
    items: items.map((item) => ({
      title: item.title,
      kind: item.kind,
      aliases: item.aliases ?? [],
      summary: item.summary ?? "",
    })),
  };
}
