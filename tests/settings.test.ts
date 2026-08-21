import { describe, expect, it } from "vitest";
import { createProvider } from "../src/core/provider/wrapper";
import { utf8 } from "../src/core/hash";
import {
  DEFAULT_SETTINGS,
  PPR_EPSILON,
  PROVIDER_TASKS,
  normalizeSettings,
} from "../src/core/types";

// handoff.md §17 — the defaults table is normative.
describe("default settings", () => {
  it("matches the §17 parameter table", () => {
    expect(DEFAULT_SETTINGS.pprAlpha).toBe(0.85);
    expect(PPR_EPSILON).toBe(1e-8);
    expect(DEFAULT_SETTINGS.pprMaxIterations).toBe(100);
    expect(DEFAULT_SETTINGS.modeMinNodes).toBe(20);
    expect(DEFAULT_SETTINGS.modeMinLinkRatio).toBe(1.5);
    expect(DEFAULT_SETTINGS.contextBudgetTokens).toBe(40_000);
    expect(DEFAULT_SETTINGS.assemblyCap).toBe(12);
    expect(DEFAULT_SETTINGS.seedsCap).toBe(8);
    expect(DEFAULT_SETTINGS.keywordsCap).toBe(12);
    expect(DEFAULT_SETTINGS.followUpEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.maxRetries).toBe(2);
    expect(DEFAULT_SETTINGS.requestTimeoutMs).toBe(120_000);
    expect(DEFAULT_SETTINGS.compileConcurrency).toBe(2);
  });

  it("maps every provider task to a model id", () => {
    for (const task of PROVIDER_TASKS) {
      expect(DEFAULT_SETTINGS.models[task]).toMatch(/\S/);
    }
  });

  it("ships no API key (invariant 9)", () => {
    expect(DEFAULT_SETTINGS.apiKey).toBe("");
  });
});

describe("a hand-edited data.json cannot make compile unsafe", () => {
  // §17 fixes these values, but `data.json` is a file a user can edit and
  // `loadSettings` validates nothing. wrapper.ts wrote this threat model down
  // for `maxRetries` and it was never applied to the three settings beside it.
  const nonsense = [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, "two" as unknown as number];

  it("falls back to §17's default for a budget that would silence every source", () => {
    for (const value of nonsense) {
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, contextBudgetTokens: value })
        .contextBudgetTokens).toBe(DEFAULT_SETTINGS.contextBudgetTokens);
    }
  });

  it("falls back for a timeout that would reject every request", () => {
    for (const value of nonsense) {
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, requestTimeoutMs: value }).requestTimeoutMs)
        .toBe(DEFAULT_SETTINGS.requestTimeoutMs);
    }
  });

  it("keeps concurrency inside a range mapWithConcurrency can act on", () => {
    for (const value of nonsense) {
      const settings = normalizeSettings({ ...DEFAULT_SETTINGS, compileConcurrency: value });
      expect(settings.compileConcurrency).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(settings.compileConcurrency)).toBe(true);
    }
    // A large value is capped rather than allowed to ignore §11's budget.
    expect(
      normalizeSettings({ ...DEFAULT_SETTINGS, compileConcurrency: 5000 }).compileConcurrency,
    ).toBe(16);
  });

  it("clamps the retry budget in the same place as the rest", () => {
    // A number outside the range is clamped into it; a value that is not a
    // number at all falls back to §17's default, which is what the rule says
    // and what a quoted `"maxRetries": "3"` in data.json deserves.
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, maxRetries: -1 }).maxRetries).toBe(0);
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, maxRetries: 5000 }).maxRetries).toBe(10);
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, maxRetries: Number.NaN }).maxRetries).toBe(
      DEFAULT_SETTINGS.maxRetries,
    );
  });

  it("answers §17's default for a quoted number, not the range floor", () => {
    const quoted = "4" as unknown as number;

    expect(normalizeSettings({ ...DEFAULT_SETTINGS, compileConcurrency: quoted })
      .compileConcurrency).toBe(DEFAULT_SETTINGS.compileConcurrency);
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, maxRetries: quoted }).maxRetries).toBe(
      DEFAULT_SETTINGS.maxRetries,
    );
  });

  it("leaves a settings object that is already valid alone", () => {
    // `toEqual`, not `toBe`, on purpose: this returns a snapshot by design, so
    // a compile sees one consistent settings state. What must *not* be
    // snapshotted is the object core holds between runs — that is invariant 9,
    // and the two tests below are what constrain it.
    expect(normalizeSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(DEFAULT_SETTINGS)).not.toBe(DEFAULT_SETTINGS);
  });
});

describe("invariant 9: settings are read at call time", () => {
  // `src/plugin/settings.ts` mutates the settings object in place and
  // `createCore` is called once in `onload()`, so anything that snapshots the
  // object at construction makes a freshly typed API key invisible until
  // Obsidian reloads — with the settings tab and data.json both saying it took.
  it("sees an API key typed after the provider was built", async () => {
    const settings = { ...DEFAULT_SETTINGS, apiKey: "" };
    const sent: string[] = [];
    const provider = createProvider({
      http: {
        async request(req) {
          sent.push(req.headers?.["x-api-key"] ?? "");
          return {
            status: 200,
            headers: {},
            bytes: utf8(JSON.stringify({ content: [{ type: "text", text: "ok" }] })),
          };
        },
      },
      settings,
      sleep: async () => {},
      random: () => 0.5,
    });

    settings.apiKey = "sk-ant-typed-later";
    await provider.complete({ task: "synthesis", system: "s", user: "u" });

    expect(sent).toEqual(["sk-ant-typed-later"]);
  });

  it("sees a model id changed after the core was built", async () => {
    const settings = { ...DEFAULT_SETTINGS, apiKey: "k" };
    const seen: string[] = [];
    const provider = createProvider({
      http: {
        async request(req) {
          seen.push((JSON.parse(req.body as string) as { model: string }).model);
          return {
            status: 200,
            headers: {},
            bytes: utf8(JSON.stringify({ content: [{ type: "text", text: "ok" }] })),
          };
        },
      },
      settings,
      sleep: async () => {},
      random: () => 0.5,
    });

    settings.models = { ...settings.models, synthesis: "claude-changed-later" };
    await provider.complete({ task: "synthesis", system: "s", user: "u" });

    expect(seen).toEqual(["claude-changed-later"]);
  });
});
