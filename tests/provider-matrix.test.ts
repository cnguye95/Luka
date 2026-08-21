// The §11 reliability wrapper, enumerated rather than sampled.
//
// The wrapper's failures are typed conditions, not a wide input space: a
// handful of transport outcomes crossed with json/prose and the retry budget
// covers all of it, and each cell has an exact answer — how many times the
// transport was called, how long the lock was held, and what came back. A
// fuzzer would sample that space less thoroughly and could not assert the
// counts, so this is a matrix.
//
// `sleep` and `random` are injected, so every delay here is exact and the whole
// file runs instantly.
import { describe, expect, it } from "vitest";
import { createProvider } from "../src/core/provider/wrapper";
import { MAX_TOKENS_BY_TASK, ProviderError, type RawRequest } from "../src/core/provider/types";
import { DEFAULT_SETTINGS, type LukaSettings } from "../src/core/types";
import { StubHttp } from "./helpers/http";

const BACKOFF_CAP_MS = 30_000;

/** One scripted transport outcome. */
type Outcome =
  | { reply: string }
  | { throw: ProviderError }
  | { throwPlain: Error };

const ok = (reply = '{"ok":true}'): Outcome => ({ reply });
const fail = (
  message: string,
  options: { retryable: boolean; status?: number; retryAfterMs?: number },
): Outcome => ({ throw: new ProviderError(message, options) });

const rateLimited = (retryAfterMs?: number): Outcome =>
  fail("rate limited", { retryable: true, status: 429, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
const serverError = (): Outcome => fail("upstream exploded", { retryable: true, status: 500 });
const badRequest = (): Outcome => fail("invalid request", { retryable: false, status: 400 });
const temperatureRejected = (): Outcome =>
  fail("temperature is not supported by this model", { retryable: false, status: 400 });
const notJson = (): Outcome => ({ reply: "Sorry, here is prose instead." });

/**
 * A transport that plays a script, recording exactly what it was handed. The
 * last entry repeats, so a script does not have to predict the retry budget.
 */
function scripted(script: readonly Outcome[]) {
  const seen: RawRequest[] = [];
  let cursor = 0;
  return {
    seen,
    raw: {
      async complete(request: RawRequest): Promise<string> {
        seen.push(request);
        const outcome = script[Math.min(cursor, script.length - 1)] as Outcome;
        cursor += 1;
        if ("throw" in outcome) throw outcome.throw;
        if ("throwPlain" in outcome) throw outcome.throwPlain;
        return outcome.reply;
      },
    },
  };
}

function harness(script: readonly Outcome[], overrides: Partial<LukaSettings> = {}) {
  const { seen, raw } = scripted(script);
  const slept: number[] = [];
  const provider = createProvider({
    http: new StubHttp({}),
    settings: { ...DEFAULT_SETTINGS, apiKey: "test-key", ...overrides },
    raw,
    sleep: async (ms) => {
      slept.push(ms);
    },
    // Fixed, so equal-jitter delays are exact rather than a range.
    random: () => 0.5,
  });
  return { provider, seen, slept };
}

const RETRIES = DEFAULT_SETTINGS.maxRetries;
const ATTEMPTS = RETRIES + 1;

describe("what reaches the transport", () => {
  it("fixes a json task at temperature 0 and caps its tokens", async () => {
    const { provider, seen } = harness([ok()]);

    await provider.complete({ task: "inventory", system: "s", user: "u", json: true });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.temperature).toBe(0);
    expect(seen[0]?.maxTokens).toBe(MAX_TOKENS_BY_TASK["inventory"]);
  });

  it("lets a caller go under the cap but never over it", async () => {
    const cap = MAX_TOKENS_BY_TASK["page-generation"];
    for (const [requested, expected] of [
      [10, 10],
      [cap + 5000, cap],
      [0, cap],
      [Number.NaN, cap],
      [-1, cap],
      [12.7, 12],
    ] as const) {
      const { provider, seen } = harness([ok("prose")]);
      await provider.complete({
        task: "page-generation",
        system: "s",
        user: "u",
        maxTokens: requested,
      });
      expect([requested, seen[0]?.maxTokens]).toEqual([requested, expected]);
    }
  });
});

describe("one transport outcome, crossed with json and prose", () => {
  const CELLS: ReadonlyArray<{
    name: string;
    script: Outcome[];
    attempts: number;
    /** The prose reply expected back, or null when the call must reject. */
    prose: string | null;
  }> = [
    { name: "2xx", script: [ok()], attempts: 1, prose: '{"ok":true}' },
    // Retryable failures use the whole budget, then give up non-retryably.
    { name: "429 forever", script: [rateLimited()], attempts: ATTEMPTS, prose: null },
    { name: "500 forever", script: [serverError()], attempts: ATTEMPTS, prose: null },
    {
      name: "network reject forever",
      script: [{ throwPlain: new Error("ECONNRESET") }],
      attempts: ATTEMPTS,
      prose: null,
    },
    // A typed non-retryable failure stops at once.
    { name: "400", script: [badRequest()], attempts: 1, prose: null },
    // Recovery inside the budget.
    { name: "429 then 2xx", script: [rateLimited(), ok()], attempts: 2, prose: '{"ok":true}' },
    {
      name: "500, 500, then 2xx",
      script: [serverError(), serverError(), ok()],
      attempts: 3,
      prose: '{"ok":true}',
    },
  ];

  for (const cell of CELLS) {
    it(`${cell.name}: prose calls the transport ${cell.attempts}×`, async () => {
      const { provider, seen } = harness(cell.script);
      const call = provider.complete({ task: "synthesis", system: "s", user: "u" });

      if (cell.prose === null) await expect(call).rejects.toThrow(ProviderError);
      else await expect(call).resolves.toBe(cell.prose);

      expect(seen).toHaveLength(cell.attempts);
      expect(provider.stats().requests).toBe(cell.attempts);
      expect(provider.stats().byTask["synthesis"]).toBe(cell.attempts);
    });

    it(`${cell.name}: json calls the transport ${cell.attempts}×`, async () => {
      const { provider, seen } = harness(cell.script);
      const call = provider.complete({ task: "inventory", system: "s", user: "u", json: true });

      if (cell.prose === null) await expect(call).rejects.toThrow(ProviderError);
      else await expect(call).resolves.toEqual(JSON.parse(cell.prose));

      expect(seen).toHaveLength(cell.attempts);
      expect(provider.stats().byTask["inventory"]).toBe(cell.attempts);
    });
  }
});

describe("a reply that is not json", () => {
  it("is repaired once, and the repair is counted", async () => {
    const { provider, seen } = harness([notJson(), ok('{"repaired":true}')]);

    await expect(
      provider.complete({ task: "inventory", system: "s", user: "u", json: true }),
    ).resolves.toEqual({ repaired: true });

    expect(seen).toHaveLength(2);
    expect(provider.stats().requests).toBe(2);
    // The repair names the parse failure and asks again, at temperature 0.
    expect(seen[1]?.user).toContain("could not be parsed as JSON");
    expect(seen[1]?.temperature).toBe(0);
  });

  it("is not repaired twice", async () => {
    const { provider, seen } = harness([notJson()]);

    await expect(
      provider.complete({ task: "inventory", system: "s", user: "u", json: true }),
    ).rejects.toThrow(/not valid JSON after one repair retry/);

    expect(seen).toHaveLength(2);
  });

  it("does not touch a prose task", async () => {
    const { provider } = harness([notJson()]);
    await expect(
      provider.complete({ task: "synthesis", system: "s", user: "u" }),
    ).resolves.toBe("Sorry, here is prose instead.");
  });
});

describe("a model that rejects the temperature parameter", () => {
  it("re-runs once without it, and counts the extra call", async () => {
    const { provider, seen } = harness([temperatureRejected(), ok()]);

    await expect(
      provider.complete({ task: "inventory", system: "s", user: "u", json: true }),
    ).resolves.toEqual({ ok: true });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.temperature).toBe(0);
    expect(seen[1]?.temperature).toBeUndefined();
    expect(provider.stats().requests).toBe(2);
  });

  it("does not re-run when there was no temperature to blame", async () => {
    const { provider, seen } = harness([temperatureRejected()]);

    await expect(
      provider.complete({ task: "synthesis", system: "s", user: "u" }),
    ).rejects.toThrow(ProviderError);

    // A prose task sends no temperature, so the 400 is just a 400.
    expect(seen).toHaveLength(1);
  });
});

describe("how long the lock is held", () => {
  it("waits equal-jitter exponential when the vendor says nothing", async () => {
    const { provider, slept } = harness([serverError()]);
    await expect(
      provider.complete({ task: "synthesis", system: "s", user: "u" }),
    ).rejects.toThrow(ProviderError);

    // random() is 0.5, so each delay is three quarters of its exponential step.
    expect(slept).toEqual([750, 1500, 3000].slice(0, RETRIES));
  });

  for (const [label, asked, expected] of [
    ["seconds", 5_000, 5_000],
    ["an hour", 3_600_000, BACKOFF_CAP_MS],
    ["absurd", Number.MAX_SAFE_INTEGER, BACKOFF_CAP_MS],
    ["zero", 0, 0],
  ] as const) {
    it(`honours a Retry-After of ${label}, bounded by the cap`, async () => {
      const { provider, slept } = harness([rateLimited(asked)]);
      await expect(
        provider.complete({ task: "synthesis", system: "s", user: "u" }),
      ).rejects.toThrow(ProviderError);

      expect(slept.every((ms) => ms === expected)).toBe(true);
      expect(slept).toHaveLength(RETRIES);
    });
  }

  it("never holds the lock longer than the cap allows, under a 429 storm", async () => {
    const { provider, slept } = harness([rateLimited(Number.MAX_SAFE_INTEGER)]);
    await expect(
      provider.complete({ task: "inventory", system: "s", user: "u", json: true }),
    ).rejects.toThrow(ProviderError);

    const total = slept.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeLessThanOrEqual(BACKOFF_CAP_MS * RETRIES);
  });
});

describe("refusals that never reach the transport", () => {
  it("refuses without an API key", async () => {
    const { provider, seen } = harness([ok()], { apiKey: "   " });
    await expect(
      provider.complete({ task: "synthesis", system: "s", user: "u" }),
    ).rejects.toThrow(/API key is not set/);
    expect(seen).toHaveLength(0);
    expect(provider.stats().requests).toBe(0);
  });

  it("refuses a task with no model configured", async () => {
    const { provider, seen } = harness([ok()], {
      models: { ...DEFAULT_SETTINGS.models, synthesis: "  " },
    });
    await expect(
      provider.complete({ task: "synthesis", system: "s", user: "u" }),
    ).rejects.toThrow(/no model configured/);
    expect(seen).toHaveLength(0);
  });
});
