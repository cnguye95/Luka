// The reliability wrapper (handoff.md §11, invariant 10).
//
// Every provider call in Luka goes through here: per-attempt timeout, retries
// with exponential backoff and jitter honoring Retry-After, per-task
// max_tokens caps, JSON parsing with one repair retry, and the call counter
// that invariant 12's "zero model calls on an unchanged vault" is asserted
// against. `sleep` and `random` are injectable so tests run instantly and
// deterministically.
import type { HttpAdapter } from "../adapters";
import type { LukaSettings, ProviderTask } from "../types";
import { PROVIDER_TASKS, normalizeSettings } from "../types";
import { createAnthropicProvider } from "./anthropic";
import {
  MAX_TOKENS_BY_TASK,
  ProviderError,
  type CompletionRequest,
  type LLMProvider,
  type ProviderImage,
  type ProviderStats,
  type RawProvider,
} from "./types";

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

export interface CreateProviderOptions {
  http: HttpAdapter;
  settings: LukaSettings;
  /** Test seam; defaults to the Anthropic transport. */
  raw?: RawProvider;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export function createProvider(options: CreateProviderOptions): LLMProvider {
  // §17's numbers are made safe here as well as in `createCore`, because this
  // is a second public entry point. `normalizeSettings` is idempotent.
  const settings = normalizeSettings(options.settings);
  const raw = options.raw ?? createAnthropicProvider(options.http, settings);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;

  let requests = 0;
  const byTask = Object.fromEntries(PROVIDER_TASKS.map((task) => [task, 0])) as Record<
    ProviderTask,
    number
  >;

  async function callWithRetries(
    task: ProviderTask,
    model: string,
    system: string,
    user: string,
    maxTokens: number,
    temperature: number | undefined,
    images: ProviderImage[] | undefined,
  ): Promise<string> {
    try {
      return await attemptLoop(task, model, system, user, maxTokens, temperature, images);
    } catch (error) {
      // §11 fixes JSON tasks at temperature 0, but some current models reject
      // sampling parameters outright with a 400. Re-run once without the
      // parameter rather than failing every call on such a model.
      if (temperature !== undefined && isTemperatureRejection(error)) {
        return attemptLoop(task, model, system, user, maxTokens, undefined, images);
      }
      throw error;
    }
  }

  // Already floored and capped by `normalizeSettings`, which owns that rule
  // for every §17 number rather than each consumer owning it for one.
  const retryBudget = settings.maxRetries;

  async function attemptLoop(
    task: ProviderTask,
    model: string,
    system: string,
    user: string,
    maxTokens: number,
    temperature: number | undefined,
    images: ProviderImage[] | undefined,
  ): Promise<string> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= retryBudget; attempt++) {
      if (attempt > 0) {
        await sleep(delayBeforeAttempt(attempt, lastError, random));
      }
      requests += 1;
      byTask[task] += 1;
      try {
        return await raw.complete({
          model,
          system,
          user,
          maxTokens,
          temperature,
          images,
          timeoutMs: settings.requestTimeoutMs,
        });
      } catch (error) {
        // Anything that is not a typed non-retryable failure — a network
        // reject, a timeout, a 429/5xx — is worth another attempt.
        if (error instanceof ProviderError && !error.retryable) {
          throw withTask(error, task);
        }
        lastError = error;
      }
    }

    const attempts = retryBudget + 1;
    throw new ProviderError(
      `${task}: giving up after ${attempts} attempt${attempts === 1 ? "" : "s"} — ${describe(lastError)}`,
      {
        task,
        retryable: false,
        status: lastError instanceof ProviderError ? lastError.status : undefined,
      },
    );
  }

  async function complete(request: CompletionRequest): Promise<unknown> {
    if (settings.apiKey.trim() === "") {
      throw new ProviderError("API key is not set — add it in Luka's settings", {
        task: request.task,
        retryable: false,
      });
    }
    const model = settings.models[request.task]?.trim();
    if (model === undefined || model === "") {
      throw new ProviderError(`no model configured for task ${request.task}`, {
        task: request.task,
        retryable: false,
      });
    }

    const cap = MAX_TOKENS_BY_TASK[request.task];
    const requested = request.maxTokens;
    // A caller may go below the cap, never above; nonsense values fall back to it.
    const maxTokens =
      typeof requested === "number" && Number.isFinite(requested) && requested >= 1
        ? Math.min(Math.floor(requested), cap)
        : cap;
    // §11: JSON tasks run at temperature 0, unconditionally.
    const temperature = request.json ? 0 : request.temperature;

    const text = await callWithRetries(
      request.task,
      model,
      request.system,
      request.user,
      maxTokens,
      temperature,
      request.images,
    );
    if (!request.json) return text;

    try {
      return JSON.parse(text) as unknown;
    } catch (parseError) {
      // §11: one repair retry, appending the parse error.
      const repairUser =
        `${request.user}\n\n` +
        `Your previous reply could not be parsed as JSON (${describe(parseError)}). ` +
        `Reply again with only valid JSON.`;
      const repaired = await callWithRetries(
        request.task,
        model,
        request.system,
        repairUser,
        maxTokens,
        0,
        request.images,
      );
      try {
        return JSON.parse(repaired) as unknown;
      } catch (secondError) {
        throw new ProviderError(
          `${request.task}: reply was not valid JSON after one repair retry — ${describe(secondError)}`,
          { task: request.task, retryable: false },
        );
      }
    }
  }

  return {
    complete: complete as LLMProvider["complete"],
    stats(): ProviderStats {
      return { requests, byTask: { ...byTask } };
    },
  };
}

function delayBeforeAttempt(attempt: number, lastError: unknown, random: () => number): number {
  if (lastError instanceof ProviderError && lastError.retryAfterMs !== undefined) {
    // Honored, but bounded: a vendor asking for an hour would otherwise hold
    // the global operation lock for that hour.
    return Math.min(lastError.retryAfterMs, BACKOFF_CAP_MS);
  }
  // Equal jitter: half the exponential step is fixed, half is random.
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
  return exponential / 2 + random() * (exponential / 2);
}

function isTemperatureRejection(error: unknown): boolean {
  // The vendor's own text, not the clipped copy `message` carries for notices.
  return (
    error instanceof ProviderError &&
    error.status === 400 &&
    /temperature/i.test(error.vendorMessage ?? error.message)
  );
}

function withTask(error: ProviderError, task: ProviderTask): ProviderError {
  if (error.task !== undefined) return error;
  // Every field is carried, `vendorMessage` included: this rebuild sits
  // between the transport and the temperature re-run, so anything dropped here
  // is a decision the wrapper stops being able to make.
  return new ProviderError(`${task}: ${error.message}`, {
    task,
    retryable: error.retryable,
    status: error.status,
    retryAfterMs: error.retryAfterMs,
    vendorMessage: error.vendorMessage,
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
