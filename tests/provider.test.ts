import { describe, expect, it } from "vitest";
import { createProvider } from "../src/core/provider/wrapper";
import {
  MAX_TOKENS_BY_TASK,
  ProviderError,
  type RawProvider,
  type RawRequest,
} from "../src/core/provider/types";
import { DEFAULT_SETTINGS, type LukaSettings } from "../src/core/types";
import { jsonRoute, ScriptedHttp } from "./helpers/http";

const SETTINGS: LukaSettings = { ...DEFAULT_SETTINGS, apiKey: "sk-test-key" };

type Step = { text: string } | { error: unknown };

/** RawProvider that replays scripted outcomes and records every request. */
class FakeRaw implements RawProvider {
  readonly calls: RawRequest[] = [];
  private cursor = 0;

  constructor(private readonly steps: Step[]) {}

  async complete(request: RawRequest): Promise<string> {
    this.calls.push(request);
    const step = this.steps[this.cursor];
    if (!step) throw new Error("FakeRaw: script exhausted");
    this.cursor += 1;
    if ("error" in step) throw step.error;
    return step.text;
  }
}

function build(steps: Step[], overrides: Partial<LukaSettings> = {}) {
  const raw = new FakeRaw(steps);
  const sleeps: number[] = [];
  const provider = createProvider({
    http: new ScriptedHttp([]),
    settings: { ...SETTINGS, ...overrides },
    raw,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1, // makes jittered delays their maximum, deterministically
  });
  return { provider, raw, sleeps };
}

const retryable = (status: number, retryAfterMs?: number) =>
  new ProviderError(`HTTP ${status}`, { status, retryable: true, retryAfterMs });

describe("wrapper — routing and caps", () => {
  it("resolves a distinct model per task from settings", async () => {
    const models = {
      inventory: "model-inv",
      "seed-selection": "model-seed",
      "page-generation": "model-page",
      synthesis: "model-syn",
      vision: "model-vis",
    };
    const { provider, raw } = build(
      Array.from({ length: 5 }, () => ({ text: "x" })),
      { models },
    );
    for (const task of Object.keys(models) as (keyof typeof models)[]) {
      await provider.complete({ task, system: "s", user: "u" });
    }
    expect(raw.calls.map((c) => c.model)).toEqual([
      "model-inv",
      "model-seed",
      "model-page",
      "model-syn",
      "model-vis",
    ]);
  });

  it("pins §11's cap table to the spec's literal numbers", () => {
    expect(MAX_TOKENS_BY_TASK).toEqual({
      inventory: 2000,
      "seed-selection": 500,
      "page-generation": 3000,
      synthesis: 4000,
      vision: 1500,
    });
  });

  it("applies the per-task cap when no maxTokens is requested", async () => {
    for (const task of ["inventory", "seed-selection", "page-generation", "synthesis", "vision"] as const) {
      const { provider, raw } = build([{ text: "x" }]);
      await provider.complete({ task, system: "s", user: "u" });
      expect(raw.calls[0]?.maxTokens).toBe(MAX_TOKENS_BY_TASK[task]);
    }
  });

  it("lets a request go below the cap but never above it", async () => {
    const { provider, raw } = build([{ text: "x" }, { text: "y" }]);
    await provider.complete({ task: "seed-selection", system: "s", user: "u", maxTokens: 100 });
    await provider.complete({ task: "seed-selection", system: "s", user: "u", maxTokens: 99999 });
    expect(raw.calls[0]?.maxTokens).toBe(100);
    expect(raw.calls[1]?.maxTokens).toBe(500);
  });

  it("falls back to the cap for nonsense maxTokens values", async () => {
    const cases: [number, number][] = [
      [Number.NaN, 500],
      [0, 500],
      [-5, 500],
      [2.7, 2],
    ];
    for (const [requested, expected] of cases) {
      const { provider, raw } = build([{ text: "x" }]);
      await provider.complete({ task: "seed-selection", system: "s", user: "u", maxTokens: requested });
      expect(raw.calls[0]?.maxTokens, `requested ${requested}`).toBe(expected);
    }
  });

  it("passes the settings timeout to every attempt, including retries", async () => {
    const { provider, raw } = build([{ error: retryable(500) }, { text: "x" }], {
      requestTimeoutMs: 45_000,
    });
    await provider.complete({ task: "synthesis", system: "s", user: "u" });
    expect(raw.calls.map((c) => c.timeoutMs)).toEqual([45_000, 45_000]);
  });

  it("forces temperature 0 on JSON tasks, overriding the request", async () => {
    const { provider, raw } = build([{ text: '{"ok":true}' }]);
    await provider.complete({ task: "inventory", system: "s", user: "u", temperature: 0.9, json: true });
    expect(raw.calls[0]?.temperature).toBe(0);
  });

  it("passes prose temperature through, including undefined", async () => {
    const { provider, raw } = build([{ text: "x" }, { text: "y" }]);
    await provider.complete({ task: "synthesis", system: "s", user: "u", temperature: 0.7 });
    await provider.complete({ task: "synthesis", system: "s", user: "u" });
    expect(raw.calls[0]?.temperature).toBe(0.7);
    expect(raw.calls[1]?.temperature).toBeUndefined();
  });
});

describe("wrapper — retries and backoff (§11)", () => {
  it("retries a retryable failure and succeeds", async () => {
    const { provider, raw, sleeps } = build([
      { error: retryable(429) },
      { error: retryable(500) },
      { text: "recovered" },
    ]);
    await expect(
      provider.complete({ task: "synthesis", system: "s", user: "u" }),
    ).resolves.toBe("recovered");
    expect(raw.calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it("retries a network rejection (no status at all)", async () => {
    const { provider, raw } = build([
      { error: new Error("socket hang up") },
      { text: "ok" },
    ]);
    await expect(provider.complete({ task: "synthesis", system: "s", user: "u" })).resolves.toBe(
      "ok",
    );
    expect(raw.calls).toHaveLength(2);
  });

  it("backs off exponentially with jitter: 1s then 2s at random()=1, half that at random()=0", async () => {
    const { provider, sleeps } = build([
      { error: retryable(500) },
      { error: retryable(500) },
      { text: "ok" },
    ]);
    await provider.complete({ task: "synthesis", system: "s", user: "u" });
    expect(sleeps).toEqual([1000, 2000]);

    const floor = (() => {
      const raw = new FakeRaw([{ error: retryable(500) }, { error: retryable(500) }, { text: "ok" }]);
      const delays: number[] = [];
      const provider2 = createProvider({
        http: new ScriptedHttp([]),
        settings: SETTINGS,
        raw,
        sleep: async (ms) => {
          delays.push(ms);
        },
        random: () => 0,
      });
      return provider2.complete({ task: "synthesis", system: "s", user: "u" }).then(() => delays);
    })();
    await expect(floor).resolves.toEqual([500, 1000]);
  });

  it("honors Retry-After over its own backoff, in both directions", async () => {
    const larger = build([{ error: retryable(429, 3000) }, { text: "ok" }]);
    await larger.provider.complete({ task: "synthesis", system: "s", user: "u" });
    expect(larger.sleeps).toEqual([3000]);

    // Smaller than the 1000ms backoff too — honoring means using it, not max().
    const smaller = build([{ error: retryable(429, 100) }, { text: "ok" }]);
    await smaller.provider.complete({ task: "synthesis", system: "s", user: "u" });
    expect(smaller.sleeps).toEqual([100]);
  });

  it("bounds a vendor Retry-After at the 30s backoff cap", async () => {
    const { provider, sleeps } = build([{ error: retryable(429, 3_600_000) }, { text: "ok" }]);
    await provider.complete({ task: "synthesis", system: "s", user: "u" });
    expect(sleeps).toEqual([30_000]);
  });

  it("applies Retry-After only to the attempt that sent it", async () => {
    const { provider, sleeps } = build([
      { error: retryable(429, 700) },
      { error: retryable(500) },
      { text: "ok" },
    ]);
    await provider.complete({ task: "synthesis", system: "s", user: "u" });
    expect(sleeps).toEqual([700, 2000]);
  });

  it("caps exponential backoff at 30s once attempts climb high enough", async () => {
    const { provider, raw, sleeps } = build(
      Array.from({ length: 7 }, () => ({ error: retryable(500) })),
      { maxRetries: 6 },
    );
    await expect(provider.complete({ task: "synthesis", system: "s", user: "u" })).rejects.toThrow(
      "after 7 attempts",
    );
    expect(raw.calls).toHaveLength(7);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000]);
  });

  it("fails a non-retryable status immediately, without sleeping", async () => {
    const { provider, raw, sleeps } = build([
      { error: new ProviderError("HTTP 401: bad key", { status: 401, retryable: false }) },
    ]);
    const failure = (await provider
      .complete({ task: "synthesis", system: "s", user: "u" })
      .catch((e: unknown) => e)) as ProviderError;
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure.status).toBe(401);
    expect(raw.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("gives up after maxRetries+1 attempts and says so", async () => {
    const { provider, raw } = build([
      { error: retryable(500) },
      { error: retryable(500) },
      { error: retryable(500) },
    ]);
    const failure = (await provider
      .complete({ task: "inventory", system: "s", user: "u" })
      .catch((e: unknown) => e)) as ProviderError;
    expect(failure.message).toContain("after 3 attempts");
    expect(failure.retryable).toBe(false);
    expect(raw.calls).toHaveLength(3);
  });

  it("respects a tuned maxRetries", async () => {
    const { provider, raw } = build([{ error: retryable(500) }], { maxRetries: 0 });
    await expect(provider.complete({ task: "synthesis", system: "s", user: "u" })).rejects.toThrow(
      "after 1 attempt",
    );
    expect(raw.calls).toHaveLength(1);
  });
});

describe("wrapper — JSON tasks (§11)", () => {
  it("returns the parsed object on the first try", async () => {
    const { provider, raw } = build([{ text: ' {"seeds": ["a"], "keywords": []} ' }]);
    const result = await provider.complete({
      task: "seed-selection",
      system: "s",
      user: "u",
      json: true,
    });
    expect(result).toEqual({ seeds: ["a"], keywords: [] });
    expect(raw.calls).toHaveLength(1);
  });

  it("repairs exactly once, appending the parse error to the user message", async () => {
    const { provider, raw } = build([
      { text: "Sure! Here is your JSON: {oops" },
      { text: '{"fixed": true}' },
    ]);
    const result = await provider.complete({
      task: "inventory",
      system: "s",
      user: "Original question.",
      json: true,
    });
    expect(result).toEqual({ fixed: true });
    expect(raw.calls).toHaveLength(2);

    const repair = raw.calls[1];
    expect(repair?.user).toContain("Original question.");
    // The actual parse error, not just the boilerplate around it.
    expect(repair?.user).toMatch(/could not be parsed as JSON \(.+\)/);
    expect(repair?.temperature).toBe(0);
  });

  it("throws after the repair also fails, and does not try a third time", async () => {
    const { provider, raw } = build([{ text: "not json" }, { text: "still not json" }]);
    const failure = (await provider
      .complete({ task: "inventory", system: "s", user: "u", json: true })
      .catch((e: unknown) => e)) as ProviderError;
    expect(failure.message).toContain("after one repair retry");
    expect(raw.calls).toHaveLength(2);
  });

  it("still retries transport failures inside each JSON attempt", async () => {
    const { provider, raw } = build([
      { error: retryable(429) },
      { text: "{bad" },
      { error: retryable(500) },
      { text: '{"ok":1}' },
    ]);
    const result = await provider.complete({ task: "inventory", system: "s", user: "u", json: true });
    expect(result).toEqual({ ok: 1 });
    expect(raw.calls).toHaveLength(4);
  });
});

describe("wrapper — models that reject sampling parameters", () => {
  const temperatureRejection = new ProviderError(
    "HTTP 400: `temperature` is not supported by this model",
    { status: 400, retryable: false },
  );

  it("re-runs a JSON task without temperature when the model rejects it", async () => {
    const { provider, raw, sleeps } = build([
      { error: temperatureRejection },
      { text: '{"ok":1}' },
    ]);
    const result = await provider.complete({ task: "inventory", system: "s", user: "u", json: true });
    expect(result).toEqual({ ok: 1 });
    expect(raw.calls).toHaveLength(2);
    expect(raw.calls[0]?.temperature).toBe(0);
    expect(raw.calls[1]?.temperature).toBeUndefined();
    expect(sleeps).toEqual([]);
    expect(provider.stats().requests).toBe(2);
  });

  it("re-runs a prose task the same way", async () => {
    const { provider, raw } = build([{ error: temperatureRejection }, { text: "prose" }]);
    await expect(
      provider.complete({ task: "synthesis", system: "s", user: "u", temperature: 0.7 }),
    ).resolves.toBe("prose");
    expect(raw.calls[1]?.temperature).toBeUndefined();
  });

  it("does not re-run when no temperature was sent, or for unrelated 400s", async () => {
    const noTemp = build([{ error: temperatureRejection }]);
    await expect(
      noTemp.provider.complete({ task: "synthesis", system: "s", user: "u" }),
    ).rejects.toThrow("temperature");
    expect(noTemp.raw.calls).toHaveLength(1);

    const unrelated = build([
      { error: new ProviderError("HTTP 400: system too long", { status: 400, retryable: false }) },
    ]);
    await expect(
      unrelated.provider.complete({ task: "inventory", system: "s", user: "u", json: true }),
    ).rejects.toThrow("system too long");
    expect(unrelated.raw.calls).toHaveLength(1);
  });
});

describe("wrapper — guards and the call counter (invariants 9, 12)", () => {
  it("fails before any transport attempt when the key is missing", async () => {
    const { provider, raw } = build([{ text: "never" }], { apiKey: "  " });
    await expect(provider.complete({ task: "synthesis", system: "s", user: "u" })).rejects.toThrow(
      "API key is not set",
    );
    expect(raw.calls).toHaveLength(0);
    expect(provider.stats().requests).toBe(0);
  });

  it("fails when the task has no model configured", async () => {
    const { provider, raw } = build([{ text: "never" }], {
      models: { ...SETTINGS.models, vision: "" },
    });
    await expect(
      provider.complete({ task: "vision", system: "s", user: "u" }),
    ).rejects.toThrow("no model configured");
    expect(raw.calls).toHaveLength(0);
  });

  it("counts every transport attempt, including retries and the repair call", async () => {
    const { provider } = build([
      { error: retryable(429) },
      { text: "{bad" },
      { text: '{"ok":1}' },
      { text: "prose" },
    ]);
    await provider.complete({ task: "inventory", system: "s", user: "u", json: true });
    await provider.complete({ task: "synthesis", system: "s", user: "u" });

    const stats = provider.stats();
    expect(stats.requests).toBe(4);
    expect(stats.byTask.inventory).toBe(3);
    expect(stats.byTask.synthesis).toBe(1);
    expect(stats.byTask.vision).toBe(0);
  });

  it("reports zero before any call — the shape M2's zero-work assertion needs", () => {
    const { provider } = build([]);
    expect(provider.stats()).toEqual({
      requests: 0,
      byTask: {
        inventory: 0,
        "page-generation": 0,
        "seed-selection": 0,
        synthesis: 0,
        vision: 0,
      },
    });
  });

  it("returns a copy from stats(), not the live counters", async () => {
    const { provider } = build([{ text: "x" }]);
    const before = provider.stats();
    await provider.complete({ task: "synthesis", system: "s", user: "u" });
    expect(before.requests).toBe(0);
    expect(provider.stats().requests).toBe(1);
  });
});

describe("wrapper + anthropic end to end over scripted HTTP", () => {
  it("retries a 429 honoring Retry-After, then succeeds", async () => {
    const http = new ScriptedHttp([
      jsonRoute(429, { type: "error", error: { message: "rate limited" } }, { "retry-after": "2" }),
      jsonRoute(200, { content: [{ type: "text", text: "done" }] }),
    ]);
    const sleeps: number[] = [];
    const provider = createProvider({
      http,
      settings: SETTINGS,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 1,
    });

    await expect(provider.complete({ task: "synthesis", system: "s", user: "u" })).resolves.toBe(
      "done",
    );
    expect(sleeps).toEqual([2000]);
    expect(http.requests).toHaveLength(2);
    expect(provider.stats().requests).toBe(2);
  });
});

// §12's provider selector, from the wrapper down through the real transport.
// The wrapper is the thing that must not care which one it is holding.
describe("wrapper + openai-compatible end to end over scripted HTTP", () => {
  const CHAT_OK = jsonRoute(200, {
    choices: [{ finish_reason: "stop", message: { content: "done" } }],
  });

  const LOCAL: Partial<LukaSettings> = {
    provider: "openai-compatible",
    apiKey: "",
    openaiApiKey: "",
    openaiBaseUrl: "http://localhost:11434/v1",
  };

  function localProvider(http: ScriptedHttp, over: Partial<LukaSettings> = {}) {
    const sleeps: number[] = [];
    const provider = createProvider({
      http,
      settings: { ...SETTINGS, ...LOCAL, ...over },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 1,
    });
    return { provider, sleeps };
  }

  it("calls a keyless local server rather than refusing for want of a key", async () => {
    // The Anthropic guard would have stopped this before any request. A server
    // that does want a credential answers 401, which says more than a guard
    // written for a different vendor could.
    const http = new ScriptedHttp([CHAT_OK]);
    const { provider } = localProvider(http);

    await expect(provider.complete({ task: "synthesis", system: "s", user: "u" })).resolves.toBe(
      "done",
    );
    expect(http.requests[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(http.requests[0]?.headers?.["authorization"]).toBeUndefined();
    expect(provider.stats().requests).toBe(1);
  });

  it("spends one counted attempt learning which field carries the token cap", async () => {
    const http = new ScriptedHttp([
      jsonRoute(400, {
        error: { message: "Use 'max_completion_tokens' instead of 'max_tokens'." },
      }),
      CHAT_OK,
    ]);
    const { provider, sleeps } = localProvider(http);

    await expect(provider.complete({ task: "synthesis", system: "s", user: "u" })).resolves.toBe(
      "done",
    );
    expect(http.requests).toHaveLength(2);
    const first = JSON.parse(http.requests[0]?.body ?? "{}") as Record<string, unknown>;
    const second = JSON.parse(http.requests[1]?.body ?? "{}") as Record<string, unknown>;
    expect("max_tokens" in first).toBe(true);
    expect("max_completion_tokens" in second).toBe(true);
    expect("max_tokens" in second).toBe(false);
    // The retry is immediate, and both attempts are counted — the transport
    // never makes a request the counter cannot see.
    expect(sleeps).toEqual([1]);
    expect(provider.stats().requests).toBe(2);
  });

  it("cannot learn it with no retry budget, and says what the server said", async () => {
    // The recorded cost of doing this through the wrapper rather than inside
    // the transport: the lesson needs one retry to be applied.
    const http = new ScriptedHttp([
      jsonRoute(400, { error: { message: "Use 'max_completion_tokens' instead." } }),
      CHAT_OK,
    ]);
    const { provider } = localProvider(http, { maxRetries: 0 });

    await expect(
      provider.complete({ task: "synthesis", system: "s", user: "u" }),
    ).rejects.toThrow(/max_completion_tokens/);
    expect(http.requests).toHaveLength(1);
  });

  it("forces a JSON task to temperature 0 through this transport too (§11)", async () => {
    // The wrapper sets it, but nothing asserted it survived the second
    // transport's body builder — and a JSON task is what every compile's
    // inventory and seed calls are, so this is the temperature that travels.
    const http = new ScriptedHttp([
      jsonRoute(200, { choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] }),
    ]);
    const { provider } = localProvider(http);

    await expect(
      provider.complete({ task: "inventory", system: "s", user: "u", json: true }),
    ).resolves.toEqual({ ok: true });
    const body = JSON.parse(http.requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body["temperature"]).toBe(0);
  });

  it("still refuses an Anthropic run with no key (the guard is per provider)", async () => {
    const http = new ScriptedHttp([CHAT_OK]);
    const provider = createProvider({ http, settings: { ...SETTINGS, apiKey: "" } });

    await expect(provider.complete({ task: "synthesis", system: "s", user: "u" })).rejects.toThrow(
      "API key is not set",
    );
    expect(http.requests).toHaveLength(0);
  });
});
