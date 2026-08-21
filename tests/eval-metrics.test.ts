// The eval harness's arithmetic (handoff.md §13), against hand-computed
// numbers. Kept out of `run.ts` so it can be checked without running a process.
import { describe, expect, it } from "vitest";
import { belowFloor, recallAt, reciprocalRank, summarize } from "../eval/metrics";

const ranked = (n: number) => Array.from({ length: n }, (_unused, at) => `p${at + 1}`);

describe("recall@k", () => {
  it("is the fraction of expected pages inside the top k", () => {
    // p1 and p7 expected; only p1 is in the top 5, both are in the top 10.
    expect(recallAt(ranked(10), ["p1", "p7"], 5)).toBe(0.5);
    expect(recallAt(ranked(10), ["p1", "p7"], 10)).toBe(1);
  });

  it("is 0 when nothing expected appears", () => {
    expect(recallAt(ranked(10), ["nowhere"], 5)).toBe(0);
  });

  it("counts an expected page once, however often it is listed", () => {
    expect(recallAt(["p1", "p1", "p2"], ["p1", "p1"], 5)).toBe(1);
  });

  it("does not exceed 1 when the ranking is shorter than k", () => {
    expect(recallAt(["p1"], ["p1"], 5)).toBe(1);
  });

  it("scores a query expecting nothing as 1", () => {
    // There was nothing to miss. The alternative — 0 — lets a malformed entry
    // in queries.yaml drag the mean down as though ranking had failed.
    expect(recallAt(ranked(3), [], 5)).toBe(1);
  });
});

describe("reciprocal rank", () => {
  it("is 1/rank of the first expected page", () => {
    expect(reciprocalRank(ranked(10), ["p1"])).toBe(1);
    expect(reciprocalRank(ranked(10), ["p2"])).toBe(0.5);
    expect(reciprocalRank(ranked(10), ["p4"])).toBe(0.25);
  });

  it("takes the best rank when several are expected", () => {
    expect(reciprocalRank(ranked(10), ["p6", "p3"])).toBeCloseTo(1 / 3, 12);
  });

  it("is 0 when none appears", () => {
    expect(reciprocalRank(ranked(10), ["nowhere"])).toBe(0);
  });

  it("still counts a hit past rank 10, unlike the recalls", () => {
    // MRR's shape is that a hit at rank 40 is worth almost nothing and is
    // still distinguishable from no hit — which is what separates a regression
    // that demoted a page from one that dropped it.
    expect(reciprocalRank(ranked(50), ["p40"])).toBeCloseTo(1 / 40, 12);
    expect(recallAt(ranked(50), ["p40"], 10)).toBe(0);
  });
});

describe("the summary means", () => {
  it("averages each metric across queries", () => {
    const summary = summarize([
      { query: "a", ranked: ranked(10), expected: ["p1"] },
      { query: "b", ranked: ranked(10), expected: ["p3"] },
    ]);

    expect(summary.meanRecallAt5).toBe(1);
    // (1 + 1/3) / 2
    expect(summary.mrr).toBeCloseTo(2 / 3, 12);
    expect(summary.perQuery.map((entry) => entry.query)).toEqual(["a", "b"]);
  });

  it("answers zero for an empty run rather than dividing by zero", () => {
    const summary = summarize([]);

    expect(summary.mrr).toBe(0);
    expect(summary.meanRecallAt5).toBe(0);
  });
});

describe("the floor check", () => {
  const summary = summarize([{ query: "a", ranked: ranked(10), expected: ["p2"] }]);

  it("names every metric under its floor", () => {
    const under = belowFloor(summary, { recallAt5: 0.9, recallAt10: 0.9, mrr: 0.9 });

    expect(under.map((check) => check.metric)).toEqual(["MRR"]);
    expect(under[0]?.measured).toBe(0.5);
  });

  it("passes when everything meets its floor", () => {
    expect(belowFloor(summary, { recallAt5: 1, recallAt10: 1, mrr: 0.5 })).toEqual([]);
  });

  it("does not fail a floor recorded as its own measurement", () => {
    expect(belowFloor(summary, { recallAt5: 1, recallAt10: 1, mrr: summary.mrr })).toEqual([]);
  });

  it("tolerates a floor a hair above the measurement", () => {
    // A floor is written down from a previous run of the same code. Rounding
    // on the way through YAML can leave it a fraction above what the next run
    // computes, and failing CI on the last bit of a float would be noise.
    const floor = { recallAt5: 1, recallAt10: 1, mrr: summary.mrr + 5e-10 };

    expect(belowFloor(summary, floor)).toEqual([]);
    // Far enough above and it must still fail.
    expect(belowFloor(summary, { ...floor, mrr: summary.mrr + 1e-6 })).toHaveLength(1);
  });
});
