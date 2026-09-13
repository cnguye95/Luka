// The eval harness's arithmetic, against hand-computed
// numbers. Kept out of `run.ts` so it can be checked without running a process.
import { describe, expect, it } from "vitest";
import { belowFloor, recallAt, reciprocalRank, summarize, type Floor } from "../eval/metrics";

const ranked = (n: number) => Array.from({ length: n }, (_unused, at) => `p${at + 1}`);

/** Floors that never fire, so a test can name the one metric it is about. */
const NO_FLOOR: Floor = {
  recallAt5: 0,
  recallAt10: 0,
  mrr: 0,
  ranking: { recallAt5: 0, recallAt10: 0, mrr: 0 },
};

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
      { query: "a", ranked: ranked(10), expected: ["p1"], seeded: false },
      { query: "b", ranked: ranked(10), expected: ["p3"], seeded: false },
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

describe("the ranking-only means", () => {
  // Retrieval force-includes every page the question names, so a query whose
  // expected pages are all seeds scores the same however the ranker behaves.
  // Half of queries.yaml is that shape; averaging it in halves the amplitude
  // of any ranking change in the floored means.
  const mixed = () =>
    summarize([
      // Perfect, and perfect for free: the answer was a seed.
      { query: "seeded", ranked: ranked(10), expected: ["p1"], seeded: true },
      // The ranker actually had to place this one, and put it fourth.
      { query: "ranked", ranked: ranked(10), expected: ["p4"], seeded: false },
    ]);

  it("counts only the queries that were not fully seeded", () => {
    expect(mixed().rankingQueries).toBe(1);
    expect(mixed().perQuery).toHaveLength(2);
  });

  it("averages over that subset alone, not over every query", () => {
    const summary = mixed();

    // Overall MRR is dragged up by the free 1.0: (1 + 0.25) / 2.
    expect(summary.mrr).toBeCloseTo(0.625, 12);
    // The ranking-only mean is just the query the ranker placed.
    expect(summary.rankingMrr).toBeCloseTo(0.25, 12);
    expect(summary.rankingRecallAt5).toBe(1);
    // p4 is inside the top 5, so recall@5 cannot separate these; MRR can.
    expect(summary.rankingRecallAt10).toBe(1);
  });

  it("carries the seeded flag through to each per-query score", () => {
    expect(mixed().perQuery.map((entry) => entry.seeded)).toEqual([true, false]);
  });

  it("names which queries it averaged, so an inverted filter is visible", () => {
    // The count cannot show this: the eval fixture splits 8/8, so filtering the
    // wrong way round still counts 8. `run.ts` cross-checks the membership.
    expect(mixed().rankingQueryNames).toEqual(["ranked"]);
  });

  it("reports zero when every query was fully seeded", () => {
    // Nothing measured ranking at all. Zero — rather than a vacuous 1 — means
    // any positive floor fails, which is the right noise for a query set that
    // has stopped exercising the ranker.
    const summary = summarize([
      { query: "a", ranked: ranked(10), expected: ["p1"], seeded: true },
    ]);

    expect(summary.rankingQueries).toBe(0);
    expect(summary.rankingMrr).toBe(0);
    expect(summary.rankingRecallAt5).toBe(0);
    expect(summary.mrr).toBe(1);
  });
});

describe("the floor check", () => {
  const summary = summarize([{ query: "a", ranked: ranked(10), expected: ["p2"], seeded: false }]);

  it("names every metric under its floor", () => {
    const under = belowFloor(summary, { ...NO_FLOOR, recallAt5: 0.9, recallAt10: 0.9, mrr: 0.9 });

    expect(under.map((check) => check.metric)).toEqual(["MRR"]);
    expect(under[0]?.measured).toBe(0.5);
  });

  it("passes when everything meets its floor", () => {
    expect(belowFloor(summary, { ...NO_FLOOR, recallAt5: 1, recallAt10: 1, mrr: 0.5 })).toEqual([]);
  });

  it("does not fail a floor recorded as its own measurement", () => {
    const floor = { ...NO_FLOOR, recallAt5: 1, recallAt10: 1, mrr: summary.mrr };

    expect(belowFloor(summary, floor)).toEqual([]);
  });

  it("tolerates a floor a hair above the measurement", () => {
    // A floor is written down from a previous run of the same code. Rounding
    // on the way through YAML can leave it a fraction above what the next run
    // computes, and failing CI on the last bit of a float would be noise.
    const floor = { ...NO_FLOOR, recallAt5: 1, recallAt10: 1, mrr: summary.mrr + 5e-10 };

    expect(belowFloor(summary, floor)).toEqual([]);
    // Far enough above and it must still fail.
    expect(belowFloor(summary, { ...floor, mrr: summary.mrr + 1e-6 })).toHaveLength(1);
  });

  it("treats a floor that is not a number as a failure, not as no floor", () => {
    // A floor omitted from queries.yaml compares `measured < NaN`, which is
    // false — so the check would switch itself off rather than fail. Silently
    // skipping a floor is the exact failure the floors exist to prevent.
    const missing = {
      ...NO_FLOOR,
      ranking: { recallAt5: 0, recallAt10: 0, mrr: undefined as unknown as number },
    };

    const under = belowFloor(summary, missing);

    expect(under.map((check) => check.metric)).toEqual(["ranking MRR"]);
    expect(Number.isFinite(under[0]?.floor)).toBe(false);
  });

  it("scopes each check, so --live can report the ranking means without flooring them", () => {
    const under = belowFloor(summary, {
      recallAt5: 1.1,
      recallAt10: 1.1,
      mrr: 1.1,
      ranking: { recallAt5: 1.1, recallAt10: 1.1, mrr: 1.1 },
    });

    // Asserted as a mapping, not as two counts of three. The counts are
    // symmetric: they hold just as well with every label swapped, which would
    // make `--live` skip the overall floors and enforce the ranking ones.
    expect(under.map((check) => [check.metric, check.scope])).toEqual([
      ["recall@5", "overall"],
      ["recall@10", "overall"],
      ["MRR", "overall"],
      ["ranking recall@5", "ranking"],
      ["ranking recall@10", "ranking"],
      ["ranking MRR", "ranking"],
    ]);
  });

  it("fails a ranking floor while every overall mean still passes", () => {
    // The point of the subset. One seeded query scoring 1.0 holds the overall
    // MRR at 0.625 — above its floor — while the query the ranker actually
    // placed sits at 0.25, under a ranking floor of 0.5.
    const diluted = summarize([
      { query: "seeded", ranked: ranked(10), expected: ["p1"], seeded: true },
      { query: "ranked", ranked: ranked(10), expected: ["p4"], seeded: false },
    ]);
    const floor: Floor = {
      recallAt5: 0.9,
      recallAt10: 0.9,
      mrr: 0.6,
      ranking: { recallAt5: 0.9, recallAt10: 0.9, mrr: 0.5 },
    };

    const under = belowFloor(diluted, floor);

    expect(under.map((check) => check.metric)).toEqual(["ranking MRR"]);
    expect(under[0]?.measured).toBeCloseTo(0.25, 12);
    // And the overall MRR genuinely did clear its floor — the failure came
    // only from the subset, not from a floor both means were under.
    expect(diluted.mrr).toBeGreaterThan(floor.mrr);
  });
});
