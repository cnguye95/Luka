// Ranking metrics for the eval harness (handoff.md §13).
//
// "reports recall@5, recall@10, MRR per query and mean; exits nonzero below a
// floor recorded in the YAML."
//
// Separate from `run.ts` so the arithmetic can be checked against hand-computed
// numbers without running a process — §3's tree does not name this file, and it
// exists for the same reason `pagetable.ts` did: the thing several callers read
// gets one home rather than being inlined where it cannot be tested.
//
// The means come in two flavours. §7.4 step 2 force-includes every page whose
// title or alias appears in the question, so for a query that names all of its
// expected pages the answer is handed to the ranker before ranking happens:
// that query scores perfectly whatever the ranker does. Half of `queries.yaml`
// is that shape, which is enough to hold the overall mean above its floor while
// graph ranking degrades underneath it — measured, not supposed. So the
// `ranking*` fields repeat the arithmetic over just the queries whose expected
// pages were *not* all seeded, and those carry floors of their own.

export interface QueryOutcome {
  query: string;
  /** Ranked page paths, best first. */
  ranked: readonly string[];
  /** Page paths the query is expected to surface. */
  expected: readonly string[];
  /**
   * Every expected page was force-included as a seed, so this query scores the
   * seeding rule rather than the ranker. Such queries are counted in the
   * overall means and excluded from the `ranking*` ones.
   */
  seeded: boolean;
}

export interface QueryScore {
  query: string;
  recallAt5: number;
  recallAt10: number;
  /** Reciprocal rank of the first expected page, or 0 if none appears. */
  reciprocalRank: number;
  /** Carried through from the outcome; see `QueryOutcome.seeded`. */
  seeded: boolean;
}

export interface Summary {
  perQuery: QueryScore[];
  meanRecallAt5: number;
  meanRecallAt10: number;
  mrr: number;
  /** How many queries fed the `ranking*` means. */
  rankingQueries: number;
  rankingRecallAt5: number;
  rankingRecallAt10: number;
  rankingMrr: number;
}

/**
 * Fraction of the expected pages that appear in the top `k`.
 *
 * A query expecting nothing scores 1: there was nothing to miss. That is the
 * only defensible reading, and it keeps a malformed entry in `queries.yaml`
 * from quietly dragging the mean down as though ranking had failed.
 */
export function recallAt(ranked: readonly string[], expected: readonly string[], k: number): number {
  if (expected.length === 0) return 1;
  const top = new Set(ranked.slice(0, k));
  let found = 0;
  for (const path of new Set(expected)) if (top.has(path)) found += 1;
  return found / new Set(expected).size;
}

/**
 * 1/rank of the first expected page anywhere in the ranking, or 0.
 *
 * Not capped at 10 like the recalls: MRR's whole shape is that a hit at rank 40
 * is worth almost nothing but is still distinguishable from no hit at all,
 * which is what tells a regression that moved a page from 3 to 40 apart from
 * one that dropped it entirely.
 */
export function reciprocalRank(ranked: readonly string[], expected: readonly string[]): number {
  const wanted = new Set(expected);
  for (let at = 0; at < ranked.length; at++) {
    if (wanted.has(ranked[at] as string)) return 1 / (at + 1);
  }
  return 0;
}

export function score(outcome: QueryOutcome): QueryScore {
  return {
    query: outcome.query,
    recallAt5: recallAt(outcome.ranked, outcome.expected, 5),
    recallAt10: recallAt(outcome.ranked, outcome.expected, 10),
    reciprocalRank: reciprocalRank(outcome.ranked, outcome.expected),
    seeded: outcome.seeded,
  };
}

export function summarize(outcomes: readonly QueryOutcome[]): Summary {
  const perQuery = outcomes.map(score);
  const ranking = perQuery.filter((entry) => !entry.seeded);
  return {
    perQuery,
    meanRecallAt5: mean(perQuery.map((entry) => entry.recallAt5)),
    meanRecallAt10: mean(perQuery.map((entry) => entry.recallAt10)),
    mrr: mean(perQuery.map((entry) => entry.reciprocalRank)),
    rankingQueries: ranking.length,
    rankingRecallAt5: mean(ranking.map((entry) => entry.recallAt5)),
    rankingRecallAt10: mean(ranking.map((entry) => entry.recallAt10)),
    rankingMrr: mean(ranking.map((entry) => entry.reciprocalRank)),
  };
}

export interface Means {
  recallAt5: number;
  recallAt10: number;
  mrr: number;
}

export interface Floor extends Means {
  /**
   * Floors for the queries that actually exercise ranking. Required: a mode
   * that records only the overall floors is the gap this exists to close, and
   * a missing one must fail loudly rather than skip the check.
   */
  ranking: Means;
}

export interface FloorCheck {
  metric: string;
  measured: number;
  floor: number;
}

/** Every metric that came in under its floor. Empty means the run passes. */
export function belowFloor(summary: Summary, floor: Floor): FloorCheck[] {
  const checks: FloorCheck[] = [
    { metric: "recall@5", measured: summary.meanRecallAt5, floor: floor.recallAt5 },
    { metric: "recall@10", measured: summary.meanRecallAt10, floor: floor.recallAt10 },
    { metric: "MRR", measured: summary.mrr, floor: floor.mrr },
    {
      metric: "ranking recall@5",
      measured: summary.rankingRecallAt5,
      floor: floor.ranking.recallAt5,
    },
    {
      metric: "ranking recall@10",
      measured: summary.rankingRecallAt10,
      floor: floor.ranking.recallAt10,
    },
    { metric: "ranking MRR", measured: summary.rankingMrr, floor: floor.ranking.mrr },
  ];
  // A hair of slack for float comparison: a floor recorded as the measured
  // value should not fail against its own measurement.
  return checks.filter((check) => check.measured < check.floor - 1e-9);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
