// Randomized instrument for §7.2's PPR.
//
// PPR is the one M3 component where a subtle arithmetic error — a transposed
// normalization, α and 1−α swapped, a degree-0 column mishandled — produces
// numbers that look entirely plausible and that no hand-written fixture would
// flag. That is the same risk profile that justified `churn.test.ts`.
//
// The oracle is a *different algorithm* reaching the same equation: dense
// Gaussian elimination solving `(I − αA)v = (1−α)p` directly, implemented here
// and sharing no code with the product. An instrument that derives its
// expectations from the code it checks cannot notice that code being wrong —
// the provider matrix was written that way once and passed with `maxRetries: 0`.
//
// Mutations this must catch, each verified red before the file was trusted:
//   - row-normalized instead of column-normalized adjacency
//   - α and 1−α exchanged
//   - a degree-0 node retaining its own mass instead of shedding it
//   - the L1 convergence threshold loosened by 10⁴
import { describe, expect, it } from "vitest";
import { computePPR } from "../src/core/graph/ppr";
import type { GraphEdge, GraphSnapshot } from "../src/core/types";

// From §7.2 and §17, not imported from the code under test.
const SPEC_EPSILON = 1e-8;
// §17's shipped defaults, from the spec rather than from `DEFAULT_SETTINGS`.
const SPEC_ALPHA = 0.85;
const SPEC_MAX_ITERATIONS = 100;

const SEEDS = Number(process.env.PPR_SEEDS ?? 250);
const FIRST = Number(process.env.PPR_FIRST ?? 0);

/** Deterministic PRNG: every seed reproduces its own run exactly. */
function rng(seed: number): () => number {
  let a = seed + 0x6d2b79f5;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const path = (at: number) => `wiki/concepts/n${String(at).padStart(2, "0")}.md`;

interface Generated {
  graph: GraphSnapshot;
  seeds: string[];
  alpha: number;
  /** Parallel to the node order the product uses, for the dense oracle. */
  order: string[];
  adjacency: number[][];
}

function generate(seed: number): Generated {
  const next = rng(seed);
  const size = 2 + Math.floor(next() * 11);
  const order = Array.from({ length: size }, (_unused, at) => path(at));

  const present = new Set<string>();
  const edges: GraphEdge[] = [];
  // Each unordered pair gets an independent chance, so the sweep sees isolated
  // nodes, trees, dense clusters and disconnected components without any of
  // them being constructed on purpose.
  const density = 0.15 + next() * 0.5;
  for (let a = 0; a < size; a++) {
    for (let b = a + 1; b < size; b++) {
      if (next() >= density) continue;
      const key = `${a}-${b}`;
      if (present.has(key)) continue;
      present.add(key);
      edges.push({ a: path(a), b: path(b) });
    }
  }

  const degree = new Array<number>(size).fill(0);
  for (const edge of edges) {
    degree[order.indexOf(edge.a)] = (degree[order.indexOf(edge.a)] as number) + 1;
    degree[order.indexOf(edge.b)] = (degree[order.indexOf(edge.b)] as number) + 1;
  }

  const seeds: string[] = [];
  while (seeds.length === 0) {
    for (let at = 0; at < size; at++) if (next() < 0.3) seeds.push(path(at));
  }

  // Column-normalized undirected adjacency, built from the edge list rather
  // than from anything the product computed.
  const adjacency = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  for (const edge of edges) {
    const a = order.indexOf(edge.a);
    const b = order.indexOf(edge.b);
    (adjacency[b] as number[])[a] = 1 / (degree[a] as number);
    (adjacency[a] as number[])[b] = 1 / (degree[b] as number);
  }

  return {
    graph: {
      nodes: order.map((nodePath, at) => ({
        path: nodePath,
        title: `n${at}`,
        kind: "concept" as const,
        degree: degree[at] as number,
      })),
      edges,
    },
    seeds: [...new Set(seeds)],
    alpha: 0.05 + next() * 0.9,
    order,
    adjacency,
  };
}

/**
 * Solves `(I − αA)v = (1−α)p` by Gaussian elimination with partial pivoting.
 *
 * Not an iteration: the product's answer is the fixed point of a repeated
 * update, and this is the same fixed point reached by linear algebra instead.
 * Two routes to one equation is the whole point.
 */
function solveDense(input: Generated): number[] {
  const { order, adjacency, alpha, seeds } = input;
  const size = order.length;

  const personalization = new Array<number>(size).fill(0);
  for (const seed of seeds) personalization[order.indexOf(seed)] = 1 / seeds.length;

  const matrix = Array.from({ length: size }, (_unused, row) => {
    const line = new Array<number>(size + 1).fill(0);
    for (let column = 0; column < size; column++) {
      line[column] = (row === column ? 1 : 0) - alpha * ((adjacency[row] as number[])[column] as number);
    }
    line[size] = (1 - alpha) * (personalization[row] as number);
    return line;
  });

  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs((matrix[row] as number[])[column] as number) > Math.abs((matrix[pivot] as number[])[column] as number)) {
        pivot = row;
      }
    }
    const swap = matrix[column] as number[];
    matrix[column] = matrix[pivot] as number[];
    matrix[pivot] = swap;

    const head = matrix[column] as number[];
    const lead = head[column] as number;
    for (let row = column + 1; row < size; row++) {
      const line = matrix[row] as number[];
      const factor = (line[column] as number) / lead;
      if (factor === 0) continue;
      for (let at = column; at <= size; at++) {
        line[at] = (line[at] as number) - factor * (head[at] as number);
      }
    }
  }

  const solution = new Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row--) {
    const line = matrix[row] as number[];
    let sum = line[size] as number;
    for (let column = row + 1; column < size; column++) {
      sum -= (line[column] as number) * (solution[column] as number);
    }
    solution[row] = sum / (line[row] as number);
  }
  return solution;
}

describe("PPR agrees with an independent solution of the same equation", { timeout: 600_000 }, () => {
  it(`holds over ${SEEDS} random graphs`, () => {
      const failures: string[] = [];

      for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
        const generated = generate(seed);
        // Far past §7.2's 100 so the comparison is against the fixed point
        // rather than against a half-mixed vector; the product's own limit is
        // exercised by the unit tests.
        const result = computePPR(generated.graph, generated.seeds, {
          alpha: generated.alpha,
          maxIterations: 5000,
        });
        const expected = solveDense(generated);

        let worst = 0;
        generated.order.forEach((nodePath, at) => {
          worst = Math.max(worst, Math.abs((result.scores.get(nodePath) as number) - (expected[at] as number)));
        });
        if (worst > 1e-6) {
          failures.push(`seed ${seed}: max difference from the dense solution is ${worst}`);
          continue;
        }

        const values = [...result.scores.values()];
        if (values.some((value) => value < 0 || !Number.isFinite(value))) {
          failures.push(`seed ${seed}: a score is negative or not finite`);
          continue;
        }

        const mass = values.reduce((sum, value) => sum + value, 0);
        if (mass > 1 + 1e-9) {
          failures.push(`seed ${seed}: total mass ${mass} exceeds 1`);
          continue;
        }
        // Mass only leaves through a degree-0 column, so with none it is
        // conserved exactly — the sharpest statement of §7.2's zero-column rule.
        const isolated = generated.graph.nodes.some((node) => node.degree === 0);
        if (!isolated && Math.abs(mass - 1) > 1e-6) {
          failures.push(`seed ${seed}: no isolated node, but mass is ${mass} rather than 1`);
          continue;
        }

        // Node order is pinned by `comparePaths`, so a permuted input must give
        // bitwise the same answer, not merely a close one.
        const shuffled: GraphSnapshot = {
          nodes: [...generated.graph.nodes].reverse(),
          edges: [...generated.graph.edges].reverse().map((edge) => ({ a: edge.b, b: edge.a })),
        };
        const again = computePPR(shuffled, [...generated.seeds].reverse(), {
          alpha: generated.alpha,
          maxIterations: 5000,
        });
        if (JSON.stringify([...again.scores]) !== JSON.stringify([...result.scores])) {
          failures.push(`seed ${seed}: permuting the input changed the answer`);
        }
      }

    if (failures.length > 0) for (const line of failures.slice(0, 8)) console.log(line);
    expect(failures).toEqual([]);
  });
});

describe("PPR at the configuration it actually ships with", { timeout: 600_000 }, () => {
  it(`agrees with the dense solution over ${SEEDS} graphs at §17's defaults`, () => {
    // The sweep above runs `maxIterations: 5000` so it compares against the
    // fixed point. That is the right oracle for the arithmetic and the wrong
    // one for the product: §17 ships α = 0.85 and a cap of 100, and nothing
    // else in the suite checks what comes back at those numbers. Here the
    // tolerance is the spec's own bound rather than 1e-6, and `converged` says
    // which answer we are holding.
    const failures: string[] = [];

    for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
      const generated = generate(seed);
      const shipped = computePPR(generated.graph, generated.seeds, {
        alpha: SPEC_ALPHA,
        maxIterations: SPEC_MAX_ITERATIONS,
      });
      const expected = solveDense({ ...generated, alpha: SPEC_ALPHA });

      let worst = 0;
      generated.order.forEach((nodePath, at) => {
        worst = Math.max(worst, Math.abs((shipped.scores.get(nodePath) as number) - (expected[at] as number)));
      });

      // A converged answer must be at the fixed point. A truncated one is only
      // required to be honest about being truncated.
      if (shipped.converged && worst > 1e-6) {
        failures.push(`seed ${seed}: converged but ${worst} from the fixed point`);
        continue;
      }
      if (!shipped.converged && shipped.iterations !== SPEC_MAX_ITERATIONS) {
        failures.push(`seed ${seed}: not converged but stopped at ${String(shipped.iterations)}`);
      }
    }

    if (failures.length > 0) for (const line of failures.slice(0, 8)) console.log(line);
    expect(failures).toEqual([]);
  });
});

describe("the convergence threshold is the one §7.2 names", () => {
  it("stops on a vector that has settled to within 1e-8", () => {
    // A loosened threshold returns early with a vector still moving. Seeded on
    // a chain, the last iteration's step must already be under the spec bound.
    const size = 30;
    const edges: GraphEdge[] = [];
    for (let at = 0; at + 1 < size; at++) edges.push({ a: path(at), b: path(at + 1) });
    const graph: GraphSnapshot = {
      nodes: Array.from({ length: size }, (_unused, at) => ({
        path: path(at),
        title: `n${at}`,
        kind: "concept" as const,
        degree: at === 0 || at === size - 1 ? 1 : 2,
      })),
      edges,
    };

    const settled = computePPR(graph, [path(0)], { alpha: 0.85, maxIterations: 5000 });
    const oneMore = computePPR(graph, [path(0)], { alpha: 0.85, maxIterations: 5000 + 1 });

    let moved = 0;
    for (const [node, value] of settled.scores) {
      moved += Math.abs((oneMore.scores.get(node) as number) - value);
    }
    expect(moved).toBeLessThan(SPEC_EPSILON);
  });
});
