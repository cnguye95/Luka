import { describe, expect, it } from "vitest";
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
    ).toBeLessThanOrEqual(16);
  });

  it("clamps the retry budget in the same place as the rest", () => {
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, maxRetries: -1 }).maxRetries).toBe(0);
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, maxRetries: 5000 }).maxRetries).toBe(10);
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, maxRetries: Number.NaN }).maxRetries).toBe(0);
  });

  it("leaves a settings object that is already valid alone", () => {
    expect(normalizeSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });
});
