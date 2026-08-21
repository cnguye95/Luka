// Opt-in functionality test against the real Anthropic API.
//
// Runs ONLY when ANTHROPIC_API_KEY is set in the environment:
//   ANTHROPIC_API_KEY=sk-ant-... npm test
// CI never sets it, so these are always skipped there. Cost per run is a
// fraction of a cent (two calls, tiny max_tokens).
import { describe, expect, it } from "vitest";
import { createProvider } from "../src/core/provider/wrapper";
import { DEFAULT_SETTINGS, type LukaSettings } from "../src/core/types";
import { NodeHttp } from "../eval/nodehttp";

const key = process.env["ANTHROPIC_API_KEY"];

describe.skipIf(!key)("live provider (opt-in: set ANTHROPIC_API_KEY)", () => {
  const settings: LukaSettings = { ...DEFAULT_SETTINGS, apiKey: key ?? "" };
  const provider = createProvider({ http: new NodeHttp(), settings });

  // Note: the 60s vitest timeout is below the wrapper's 120s per-attempt
  // request timeout, so a hang surfaces as a test timeout — fine for a smoke.
  it("completes a JSON task and returns the requested object", { timeout: 60_000 }, async () => {
    const result = await provider.complete({
      task: "seed-selection",
      system: "You reply with strict JSON only. No prose, no code fences.",
      user: 'Return exactly this JSON object: {"ok": true}',
      json: true,
      maxTokens: 64,
    });
    expect(result).toEqual({ ok: true });
  });

  it("completes a prose task with the requested word", { timeout: 60_000 }, async () => {
    const result = await provider.complete({
      task: "synthesis",
      system: "You are terse.",
      user: "Reply with the single word: ready",
      maxTokens: 64,
    });
    expect(result).toMatch(/ready/i);
  });
});
