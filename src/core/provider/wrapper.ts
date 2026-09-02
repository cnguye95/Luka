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
  /**
   * Read at call time, never snapshotted.
   *
   * Invariant 9 says the API key is read from settings when the call is made,
   * and the plugin mutates its settings object *in place* while `createCore`
   * runs once in `onload()` — so a copy taken here makes a freshly typed key
   * invisible until Obsidian reloads, with the settings tab and data.json both
   * reporting success. §17's numbers are made safe on the way past;
   * `normalizeSettings` is idempotent, so a caller that already normalized
   * loses nothing.
   */
  const current = (): LukaSettings => normalizeSettings(options.settings);
  const raw = options.raw ?? createAnthropicProvider(options.http, options.settings);
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

    const retryBudget = current().maxRetries;
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
          timeoutMs: current().requestTimeoutMs,
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
      // Every field of the underlying error is carried, for the same reason
      // `withTask` carries them: a rebuild that drops one is a decision the
      // wrapper stops being able to make. `describe(lastError)` above is the
      // *clipped* message, so `vendorMessage` is the only unclipped copy left.
      {
        task,
        retryable: false,
        status: lastError instanceof ProviderError ? lastError.status : undefined,
        retryAfterMs: lastError instanceof ProviderError ? lastError.retryAfterMs : undefined,
        vendorMessage: lastError instanceof ProviderError ? lastError.vendorMessage : undefined,
      },
    );
  }

  async function complete(request: CompletionRequest): Promise<unknown> {
    if (current().apiKey.trim() === "") {
      throw new ProviderError("API key is not set — add it in Luka's settings", {
        task: request.task,
        retryable: false,
      });
    }
    const model = current().models[request.task]?.trim();
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
      return JSON.parse(unfence(text)) as unknown;
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
        return JSON.parse(unfence(repaired)) as unknown;
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

/**
 * Unwraps a JSON reply the model returned inside a markdown fence.
 *
 * §11 asks only for "parse, one repair retry", and the repair was written for
 * exactly this shape — but it re-asks the same model, so it is a fix only when
 * the model complies the second time. `claude-haiku-4-5-20251001` fences the
 * repair reply too: every source of a real compile failed at `inventory` and
 * no manifest was written at all. Stripping is deterministic where re-asking
 * is not, and it costs no call.
 *
 * Deliberately narrow. Only a reply whose *entire* trimmed body is one fenced
 * block is unwrapped, so prose that merely contains a fence still fails to
 * parse and still reaches the repair retry — the case that genuinely needs
 * another look at the model. `synthesize.ts` strips the *trailing* block out of
 * prose, which is §8.2's different question and stays where it is; unifying
 * the two would put one regex in front of two grammars.
 */
function unfence(text: string): string {
  const fenced = /^```(?:[A-Za-z0-9_-]+)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text.trim());
  return fenced === null ? text : (fenced[1] as string);
}

function delayBeforeAttempt(attempt: number, lastError: unknown, random: () => number): number {
  if (lastError instanceof ProviderError && lastError.retryAfterMs !== undefined) {
    // Honored, but bounded: a vendor asking for an hour would otherwise hold
    // the global operation lock for that hour. Honoring means using the value,
    // not max()-ing it against the ladder — a vendor that says 100ms knows
    // something the ladder does not. A zero is filtered out at the parse
    // boundary rather than here, because it is not a shorter delay, it is no
    // delay at all.
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
