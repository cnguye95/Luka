import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, PPR_EPSILON, PROVIDER_TASKS } from "../src/core/types";

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
