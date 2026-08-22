// Personalized PageRank over §7.1's graph (handoff.md §7.2).
//
// "Exact power iteration. Personalization: uniform over seed nodes. Update:
// `v' = α·A·v + (1−α)·p` with α = 0.85, A the degree-normalized undirected
// adjacency. Degree-0 nodes propagate nothing (zero column) and hold teleport
// mass only. Converged when L1(v'−v) < 1e-8, max 100 iterations. Determinism:
// node order lexicographic by path; ties in ranking break lexicographically."
//
// Pure and synchronous: it is arithmetic over a snapshot, and keeping it free
// of IO is what lets the instrument compare it against an independent solution
// of the same equation.
import { comparePaths } from "../paths";
import { PPR_EPSILON, type GraphSnapshot } from "../types";

/**
 * §17 marks the scrubber's snapshot cap fixed, so it is a constant here rather
 * than a setting. §7.2 bounds retained vectors at "≤ 100" independently of the
 * iteration limit, which a hand-edited `pprMaxIterations` could otherwise push
 * past.
 */
const SNAPSHOT_CAP = 100;

export interface PPROptions {
  alpha: number;
  maxIterations: number;
  /** §7.2: "retains v after each iteration (≤ 100) for the pane". */
  snapshots?: boolean;
}

export interface PPRResult {
  scores: ReadonlyMap<string, number>;
  iterations: number;
  /**
   * Whether the iteration reached §7.2's L1 threshold, or stopped at the
   * limit with the vector still moving.
   *
   * Worth reporting because the spec's own defaults truncate on ordinary
   * topologies.
   *
   * No mechanism is claimed here, and the reason is worth stating: four
   * successive versions of this comment blamed node count, then sparsity, then
   * bipartiteness, then seed count, and every one was falsified by a two-line
   * experiment against the helpers in `ppr.test.ts`. The fourth was written in
   * the same commit that removed the third and declared no mechanism claimed.
   * Anything below that reads like a rule is a defect; these are measurements,
   * at α = 0.85 against §7.2's cap of 100 and threshold of 1e-8.
   *
   * - Chains of 2 through 16 need 118 and truncate — size does not predict it.
   * - Cycles of 3, 5, 7, 9, 11 settle in 24, 53, 73, 87, 96; cycles of 13, 31,
   *   51, 101 need 101, 116, 118, 118. Identical edges per node throughout, so
   *   density does not predict it either.
   * - Seeding more nodes does not predict it. A 4-chain seeded at all four
   *   converges in 22, but at three of the four it needs 111; a 5-chain seeded
   *   at all five needs 108; a 16-chain seeded at eight needs 118.
   * - The 65-node fixture this repo ships converges from every single seed in
   *   69–82, inside the cap but by less than a fifth of it.
   *
   * `ppr.test.ts` pins the chain-2/16 pair, the cycle-5-vs-13 pair and the
   * seed-set triple. The star figures and the per-cycle iteration counts are
   * measurements recorded here, not assertions — treat them as a starting
   * point for a re-measurement, not as a guarantee something still holds.
   *
   * All of it is spec-compliant ("max 100") and the residual is small, but a
   * caller that could not tell a settled answer from a truncated one has no
   * way to notice a change that made convergence worse. That is what this flag
   * is for.
   */
  converged: boolean;
  snapshots?: ReadonlyMap<string, number>[];
}

/**
 * Seeds not present in the graph are dropped. With no valid seed left there is
 * no personalization vector to iterate from, so every score is zero and no
 * iteration runs — an honest empty answer rather than a uniform one, which
 * would rank every node equally and look like a result.
 */
export function computePPR(
  graph: GraphSnapshot,
  seedPaths: readonly string[],
  options: PPROptions,
): PPRResult {
  const order = graph.nodes.map((node) => node.path).sort(comparePaths);
  const index = new Map(order.map((path, at) => [path, at]));
  const size = order.length;

  const seeds = [...new Set(seedPaths)].filter((path) => index.has(path));
  if (size === 0 || seeds.length === 0) {
    return {
      scores: new Map(),
      iterations: 0,
      converged: true,
      ...(options.snapshots === true ? { snapshots: [] } : {}),
    };
  }

  // Undirected adjacency as index lists. What fixes the summation order — and
  // floating-point addition is not associative, so something must — is the
  // `comparePaths` sort of `order` above: the outer loop below walks that index
  // space, and every summand accumulating into one slot arrives in that order.
  // Sorting each neighbour list only decides which distinct slot is written
  // first within a single source node, which cannot change any sum. It is kept
  // because a stable adjacency is easier to reason about and to print, not
  // because determinism rests on it.
  const neighbours: number[][] = order.map(() => []);
  for (const edge of graph.edges) {
    const a = index.get(edge.a);
    const b = index.get(edge.b);
    if (a === undefined || b === undefined) continue;
    neighbours[a]?.push(b);
    neighbours[b]?.push(a);
  }
  for (const list of neighbours) list.sort((x, y) => x - y);

  const personalization = new Array<number>(size).fill(0);
  for (const seed of seeds) personalization[index.get(seed) as number] = 1 / seeds.length;

  const alpha = options.alpha;
  let current = [...personalization];
  const snapshots: ReadonlyMap<string, number>[] = [];
  let iterations = 0;
  let converged = false;

  for (let step = 0; step < options.maxIterations; step++) {
    const next = new Array<number>(size).fill(0);
    for (let from = 0; from < size; from++) {
      const list = neighbours[from] as number[];
      // §7.2: a degree-0 node is a zero column. It propagates nothing — its
      // mass is not redistributed, it simply leaves — and holds only what
      // teleport puts back.
      if (list.length === 0) continue;
      const share = (alpha * (current[from] as number)) / list.length;
      if (share === 0) continue;
      for (const to of list) next[to] = (next[to] as number) + share;
    }
    for (let at = 0; at < size; at++) {
      next[at] = (next[at] as number) + (1 - alpha) * (personalization[at] as number);
    }

    let delta = 0;
    for (let at = 0; at < size; at++) delta += Math.abs((next[at] as number) - (current[at] as number));

    current = next;
    iterations = step + 1;
    if (options.snapshots === true && snapshots.length < SNAPSHOT_CAP) {
      snapshots.push(vectorOf(order, current));
    }
    if (delta < PPR_EPSILON) {
      converged = true;
      break;
    }
  }

  return {
    scores: vectorOf(order, current),
    iterations,
    converged,
    ...(options.snapshots === true ? { snapshots } : {}),
  };
}

function vectorOf(order: readonly string[], values: readonly number[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  order.forEach((path, at) => out.set(path, values[at] as number));
  return out;
}
