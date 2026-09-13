import { describe, expect, it } from "vitest";
import { truncatedForContextBudget } from "../src/core/markers";
import { estimateTokens, packUnderBudget, truncateToTokens } from "../src/core/tokens";

const MARKER = truncatedForContextBudget();

describe("token estimation (chars/4)", () => {
  it("rounds up so a partial token still costs one", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(40_000))).toBe(10_000);
  });
});

describe("truncateToTokens", () => {
  it("leaves text that already fits completely alone", () => {
    const text = "short enough";
    expect(truncateToTokens(text, 100)).toEqual({ text, truncated: false });
  });

  it("produces a result that fits the budget, marker included", () => {
    const text = "word ".repeat(500);
    for (const budget of [20, 50, 137, 400]) {
      const result = truncateToTokens(text, budget);
      expect(result.truncated).toBe(true);
      expect(result.text.endsWith(MARKER)).toBe(true);
      expect(estimateTokens(result.text), `budget ${budget}`).toBeLessThanOrEqual(budget);
    }
  });

  it("keeps the head of the text, not the tail", () => {
    const result = truncateToTokens(`BEGINNING ${"x".repeat(1000)} ENDING`, 30);
    expect(result.text.startsWith("BEGINNING")).toBe(true);
    expect(result.text).not.toContain("ENDING");
  });

  it("never splits a surrogate pair", () => {
    // The leading BMP char puts pair boundaries at odd offsets, so the cut
    // actually lands mid-pair without the guard.
    for (const text of [`a${"😀".repeat(200)}`, "😀".repeat(200)]) {
      for (let budget = 12; budget < 40; budget++) {
        const { text: cut } = truncateToTokens(text, budget);
        expect(hasLoneSurrogate(cut), `budget ${budget}`).toBe(false);
      }
    }
  });

  it("leaves text that exactly fills the budget untruncated", () => {
    const exact = "x".repeat(200); // 50 tokens
    expect(truncateToTokens(exact, 50)).toEqual({ text: exact, truncated: false });
  });

  it("degrades to the bare marker when the budget cannot hold content", () => {
    expect(truncateToTokens("x".repeat(500), 1)).toEqual({ text: MARKER, truncated: true });
  });
});

describe("packUnderBudget", () => {
  const size = (n: number) => "x".repeat(n * 4); // n tokens exactly

  it("takes everything when it all fits", () => {
    const result = packUnderBudget([size(10), size(10)], (t) => t, 100);
    expect(result.items).toHaveLength(2);
    expect(result.usedTokens).toBe(20);
    expect(result.truncated).toBe(false);
  });

  it("stops at the first item that does not fit and never reaches past it", () => {
    // 60 fits; 60 more would exceed 100; the small item after must NOT be
    // pulled forward — assembly order is meaningful (citation order).
    const items = [size(60), size(60), size(5)];
    const result = packUnderBudget(items, (t) => t, 100);
    expect(result.items).toEqual([items[0]]);
    expect(result.usedTokens).toBe(60);
    expect(result.truncated).toBe(false);
  });

  it("truncates a first item that alone exceeds the whole budget", () => {
    const result = packUnderBudget([size(500), size(1)], (t) => t, 50);
    expect(result.items).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.texts[0]?.endsWith(MARKER)).toBe(true);
    expect(result.usedTokens).toBeLessThanOrEqual(50);
  });

  it("does not truncate a later oversized item — it stops instead", () => {
    const result = packUnderBudget([size(10), size(500)], (t) => t, 50);
    expect(result.items).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });

  it("drops rather than truncates a first item when asked for whole items only", () => {
    // The follow-up round appends "under the remaining context budget";
    // the truncation exception is for a page over the *whole* budget, so a
    // remnant that fits no page whole yields nothing — not a fragment that a
    // third model call would then be spent on.
    const result = packUnderBudget([size(500), size(1)], (t) => t, 50, undefined, false);
    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.usedTokens).toBe(0);
  });

  it("honors the item cap before the budget (K)", () => {
    const result = packUnderBudget([size(1), size(1), size(1)], (t) => t, 10_000, 2);
    expect(result.items).toHaveLength(2);
  });

  it("handles an empty list and a zero cap", () => {
    expect(packUnderBudget([], (t: string) => t, 100).items).toEqual([]);
    expect(packUnderBudget([size(1)], (t) => t, 100, 0).items).toEqual([]);
  });

  it("takes an item that exactly fills the remaining budget", () => {
    const result = packUnderBudget([size(30), size(20), size(1)], (t) => t, 50);
    expect(result.items).toHaveLength(2);
    expect(result.usedTokens).toBe(50);
  });

  it("reports the real cost of a truncated first item, not zero", () => {
    // The follow-up round appends "under the remaining context budget",
    // computed from this number.
    const result = packUnderBudget([size(500)], (t) => t, 50);
    expect(result.usedTokens).toBeGreaterThan(40);
    expect(result.usedTokens).toBeLessThanOrEqual(50);
  });
});

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (isLow) return true;
  }
  return false;
}
