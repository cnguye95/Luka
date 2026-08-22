// §7.2's personalized PageRank, and §14's required fixture:
// "PPR against a hand-computed 5-node fixture, determinism across runs,
// degree-0 handling."
import { describe, expect, it } from "vitest";
import { computePPR } from "../src/core/graph/ppr";
import type { GraphEdge, GraphSnapshot } from "../src/core/types";

// §17's default, redeclared here rather than imported. A spec number has to
// come from the spec: expectations derived from the code they check cannot
// notice the code being wrong.
const SPEC_ALPHA = 0.85;

const N = (name: string) => `wiki/concepts/${name}.md`;

/**
 * a–b, a–c, b–c, a–d, and e isolated. Degrees: a 3, b 2, c 2, d 1, e 0.
 */
function fixture(): GraphSnapshot {
  const edges: GraphEdge[] = [
    { a: N("a"), b: N("b") },
    { a: N("a"), b: N("c") },
    { a: N("a"), b: N("d") },
    { a: N("b"), b: N("c") },
  ];
  const degree: Record<string, number> = { a: 3, b: 2, c: 2, d: 1, e: 0 };
  return {
    nodes: ["a", "b", "c", "d", "e"].map((name) => ({
      path: N(name),
      title: name,
      kind: "concept" as const,
      degree: degree[name] as number,
    })),
    edges,
  };
}

/** A path graph, which mixes slowly enough to exercise the iteration limit. */
function chain(size: number): GraphSnapshot {
  const name = (at: number) => N(`n${String(at).padStart(2, "0")}`);
  const edges: GraphEdge[] = [];
  for (let at = 0; at + 1 < size; at++) edges.push({ a: name(at), b: name(at + 1) });
  return {
    nodes: Array.from({ length: size }, (_unused, at) => ({
      path: name(at),
      title: `n${at}`,
      kind: "concept" as const,
      degree: at === 0 || at === size - 1 ? 1 : 2,
    })),
    edges,
  };
}

/**
 * A cycle. Even ones are bipartite and mix as slowly as a chain; odd ones are
 * not, and settle well inside §7.2's cap at the same edges per node.
 */
function cycle(size: number): GraphSnapshot {
  const name = (at: number) => N(`n${String(at).padStart(2, "0")}`);
  return {
    nodes: Array.from({ length: size }, (_unused, at) => ({
      path: name(at),
      title: `n${at}`,
      kind: "concept" as const,
      degree: 2,
    })),
    edges: Array.from({ length: size }, (_unused, at) => ({
      a: name(at),
      b: name((at + 1) % size),
    })),
  };
}

const run = (seeds: string[], overrides: { alpha?: number; maxIterations?: number; snapshots?: boolean } = {}) =>
  computePPR(fixture(), seeds, {
    alpha: overrides.alpha ?? SPEC_ALPHA,
    maxIterations: overrides.maxIterations ?? 100,
    ...(overrides.snapshots === true ? { snapshots: true } : {}),
  });

describe("PPR against a hand-computed fixture (§7.2)", () => {
  it("reproduces the fixed point solved by hand", () => {
    // Solving v = αAv + (1−α)p by hand with α = 17/20, seeded on `a`.
    // By symmetry v_b = v_c (each touches a and the other), so with
    //   v_b = α(v_a/3 + v_b/2)      →  v_b = (34/69)·v_a
    //   v_d = α·v_a/3               →  v_d = (17/60)·v_a
    //   v_a = α(v_b/2 + v_c/2 + v_d) + (1−α)
    // substituting gives v_a(1 − 18207/27600) = 3/20, so v_a = 1380/3131.
    const scores = run([N("a")]).scores;

    // To 8 decimals, which is what an L1 tolerance of 1e-8 buys. The residual
    // gap of ~1.5e-9 against the exact fraction is the convergence bound, and
    // it is what tells us the hand solution and the iteration agree.
    expect(scores.get(N("a"))).toBeCloseTo(1380 / 3131, 8);
    expect(scores.get(N("b"))).toBeCloseTo(680 / 3131, 8);
    expect(scores.get(N("c"))).toBeCloseTo(680 / 3131, 8);
    expect(scores.get(N("d"))).toBeCloseTo(391 / 3131, 8);
    expect(scores.get(N("e"))).toBe(0);

    // No degree-0 node holds mass here, so none leaks: the four sum to 1.
    const total = [...scores.values()].reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 8);
  });

  it("converges rather than running to the iteration limit", () => {
    const result = run([N("a")]);

    expect(result.iterations).toBeGreaterThan(1);
    expect(result.iterations).toBeLessThan(100);
  });
});

describe("degree-0 handling (§7.2)", () => {
  it("gives an isolated seed exactly the teleport mass and nothing else", () => {
    // "Degree-0 nodes propagate nothing (zero column) and hold teleport mass
    // only." Seeded on `e`, the walk has nowhere to go: `e` keeps (1−α) and
    // the rest of the mass leaves the graph rather than being redistributed.
    const scores = run([N("e")]).scores;

    expect(scores.get(N("e"))).toBeCloseTo(1 - SPEC_ALPHA, 12);
    for (const name of ["a", "b", "c", "d"]) expect(scores.get(N(name))).toBe(0);
  });

  it("scores an unseeded isolated node zero", () => {
    expect(run([N("a")]).scores.get(N("e"))).toBe(0);
  });
});

describe("seeds that name nothing (§7.4 step 2 drops them before this)", () => {
  it("answers every score zero when no seed is in the graph", () => {
    const result = run([N("nobody")]);

    expect(result.iterations).toBe(0);
    expect([...result.scores.values()]).toEqual([]);
  });

  it("ignores an unknown seed alongside a known one", () => {
    expect(run([N("a"), N("nobody")]).scores).toEqual(run([N("a")]).scores);
  });

  it("spreads personalization uniformly over several seeds", () => {
    // b and c are symmetric, so seeding both must score them identically.
    const scores = run([N("b"), N("c")]).scores;

    expect(scores.get(N("b"))).toBeCloseTo(scores.get(N("c")) as number, 12);
  });
});

describe("determinism (§7.2)", () => {
  it("orders nodes by code point, not by the host's collation", () => {
    // §7.2: "node order lexicographic by path". `comparePaths` is code-point
    // order deliberately, because `localeCompare` is locale- and ICU-dependent:
    // under it `_x` sorts before `A-B` and `alpha` before `Zeta`, which changes
    // the index assignment, hence the floating-point summation order, hence the
    // low bits of every score — differently on two users' machines. Every path
    // in the other fixtures is comparator-invariant, so nothing else here can
    // tell the two apart.
    const names = ["Zeta", "alpha", "A-B", "AB", "_x"];
    const graph: GraphSnapshot = {
      nodes: names.map((name) => ({
        path: N(name),
        title: name,
        kind: "concept" as const,
        degree: 1,
      })),
      edges: names.slice(1).map((name) => ({ a: N(names[0] as string), b: N(name) })),
    };

    const scores = computePPR(graph, [N("Zeta")], { alpha: SPEC_ALPHA, maxIterations: 100 }).scores;

    // Code-point order puts capitals first and `_` after them; a collation
    // order would interleave differently.
    expect([...scores.keys()]).toEqual([
      N("A-B"),
      N("AB"),
      N("Zeta"),
      N("_x"),
      N("alpha"),
    ]);
  });

  it("is bit-identical across runs", () => {
    expect([...run([N("a")]).scores]).toEqual([...run([N("a")]).scores]);
  });

  it("does not depend on the order nodes and edges arrive in", () => {
    // Arithmetic order is pinned by `comparePaths`, so this is exact
    // equality, not an approximation.
    const forward = fixture();
    const reversed: GraphSnapshot = {
      nodes: [...forward.nodes].reverse(),
      edges: [...forward.edges].reverse().map((edge) => ({ a: edge.b, b: edge.a })),
    };
    const options = { alpha: SPEC_ALPHA, maxIterations: 100 };

    expect([...computePPR(reversed, [N("a")], options).scores]).toEqual([
      ...computePPR(forward, [N("a")], options).scores,
    ]);
  });
});

describe("snapshots (§7.2)", () => {
  it("retains one vector per iteration when asked", () => {
    const result = run([N("a")], { snapshots: true });

    expect(result.snapshots).toHaveLength(result.iterations);
    expect(result.snapshots?.[result.snapshots.length - 1]).toEqual(result.scores);
  });

  it("retains none when not asked", () => {
    expect(run([N("a")]).snapshots).toBeUndefined();
  });

  it("never retains more than the fixed cap of 100", () => {
    // A hand-edited `pprMaxIterations` above 100 must not grow the pane's
    // memory: §7.2 bounds retained vectors independently of the loop. A long
    // chain mixes slowly enough to run past 100 iterations — α alone does not,
    // because a small dense graph converges in tens of steps whatever the
    // damping.
    const result = computePPR(chain(60), [N("n00")], {
      alpha: 0.99,
      maxIterations: 400,
      snapshots: true,
    });

    expect(result.iterations).toBeGreaterThan(100);
    expect(result.snapshots).toHaveLength(100);
  });
});

describe("the caller can tell a settled vector from a truncated one (§7.2)", () => {
  it("reports convergence on a graph that settles inside the limit", () => {
    const result = run([N("a")]);

    expect(result.converged).toBe(true);
    expect(result.iterations).toBeLessThan(100);
  });

  it("reports truncation at §17's own defaults, which a chain reaches", () => {
    // §17 ships α = 0.85 and a 100-iteration cap, and a sparse graph needs 118
    // iterations to reach L1 < 1e-8 — a figure set by α, not by node count.
    // Measured, a chain of 2 truncates exactly as a chain of 16 does, so this
    // is not a large-vault condition; the shipped configuration truncates on
    // an ordinary topology, a reading path or a chain of prerequisite notes.
    // Spec-compliant ("max 100") and the residual is ~1e-8, but without this
    // flag nothing distinguishes it from a settled answer, and a change that
    // made convergence worse would be invisible.
    const result = computePPR(chain(12), [N("n00")], { alpha: 0.85, maxIterations: 100 });

    expect(result.converged).toBe(false);
    expect(result.iterations).toBe(100);
  });

  it("truncates on a two-node chain exactly as on a long one", () => {
    // Node count is not the variable. If truncation were a large-graph
    // phenomenon this would converge.
    const short = computePPR(chain(2), [N("n00")], { alpha: 0.85, maxIterations: 100 });

    expect(short.converged).toBe(false);
    expect(short.iterations).toBe(100);
    // And both settle at the same count once the cap is lifted.
    const SPEC_SETTLES_AT = 118;
    expect(computePPR(chain(2), [N("n00")], { alpha: 0.85, maxIterations: 5000 }).iterations).toBe(
      SPEC_SETTLES_AT,
    );
    expect(computePPR(chain(16), [N("n00")], { alpha: 0.85, maxIterations: 5000 }).iterations).toBe(
      SPEC_SETTLES_AT,
    );
  });

  it("truncates on an even cycle and settles on an odd one of the same density", () => {
    // Sparsity is not the variable either — two comments in a row said it was.
    // Both cycles carry exactly one edge per node. The even one is bipartite,
    // so its walk matrix has an eigenvalue of -1 and that error component
    // decays at exactly α; the odd one has no such eigenvalue and mixes.
    const options = { alpha: 0.85, maxIterations: 100 };

    expect(computePPR(cycle(4), [N("n00")], options).converged).toBe(false);
    expect(computePPR(cycle(6), [N("n00")], options).converged).toBe(false);
    expect(computePPR(cycle(3), [N("n00")], options).converged).toBe(true);
    expect(computePPR(cycle(5), [N("n00")], options).converged).toBe(true);
    // Same edges per node on both sides of that split.
    expect(cycle(4).edges.length / cycle(4).nodes.length).toBe(1);
    expect(cycle(5).edges.length / cycle(5).nodes.length).toBe(1);
  });

  it("reports convergence for an empty seed set rather than truncation", () => {
    // Nothing to iterate is not the same as giving up part-way.
    expect(run([N("nobody")]).converged).toBe(true);
  });
});
