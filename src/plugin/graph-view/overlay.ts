// §9's overlay: "heat ramp = PPR score, ring = seeds, stroke = top-K,
// non-neighborhood dimmed."
//
// One shape, three producers. Click-PPR, query inspection and trace replay
// light the graph for different reasons and from different data, but §9
// describes one visual language for all of them — so they converge here rather
// than each teaching the renderer a new vocabulary.
//
// Pure data: no DOM, no Obsidian, no core calls. What the pane shows is a
// function of what its producer was handed.
import type { RetrievalMode } from "../../core/index";
import type { SimNode } from "./sim";

export interface Overlay {
  /**
   * Which of §9's three overlays this is.
   *
   * The pane needs to tell a click-PPR overlay — which it produced from a
   * gesture — apart from one the user deliberately asked for, so that opening a
   * page does not discard the latter.
   */
  source: "click" | "inspect" | "trace";
  /** §9's ring. */
  seeds: ReadonlySet<string>;
  /** §9's stroke. */
  topK: ReadonlySet<string>;
  /**
   * Heat-ramp intensity per node, already normalized to 0..1, or `null` when
   * there is no ramp to draw.
   *
   * §9 gives Mode-A inspection "seeds and lexical top-K without a PPR heat
   * ramp", so the absence is a state the model has to be able to express — not
   * an empty map, which would render as every node at zero heat.
   */
  scores: ReadonlyMap<string, number> | null;
  /** What the status line says this overlay is. */
  label: string;
}

/**
 * Normalizes against the strongest node.
 *
 * PPR scores on a large graph are small absolute numbers, and a ramp keyed to
 * their raw values would be flat everywhere. Relative is also the honest
 * reading: the overlay answers "what did this query reach", not "how much mass
 * in absolute terms".
 */
function normalize(scores: ReadonlyMap<string, number>): Map<string, number> {
  let peak = 0;
  for (const value of scores.values()) peak = Math.max(peak, value);
  const out = new Map<string, number>();
  // The `value > 0` test is what keeps this from dividing by zero, not a guard
  // on `peak`: if no score is positive then `peak` is not positive either, and
  // nothing enters the loop body. An earlier `if (peak <= 0) return out` looked
  // like the protection and was dead code — mutation removed it with every test
  // still green, which is how it was found.
  //
  // Reachable with every score zero (an isolated seed holds only teleport mass,
  // §7.2) and with negative ones (`parseTop` accepts a hand-edited `-0.5`).
  // Both leave the ramp empty, and seeds and top-K still light by name.
  for (const [path, value] of scores) if (value > 0) out.set(path, value / peak);
  return out;
}

/** The `k` highest scorers, ties broken by path so two runs agree (§7.2). */
function topOf(scores: ReadonlyMap<string, number>, k: number): Set<string> {
  return new Set(
    [...scores]
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, k)
      .map(([path]) => path),
  );
}

/** §9: "click a node → instant PPR from that node (no model call)". */
export function fromClickPPR(
  scores: ReadonlyMap<string, number>,
  seedPath: string,
  k: number,
): Overlay {
  return {
    source: "click",
    seeds: new Set([seedPath]),
    topK: topOf(scores, k),
    scores: normalize(scores),
    label: `PPR from ${seedPath}`,
  };
}

/**
 * §9's query inspection.
 *
 * Mode B ramps from the ranking's own scores. Mode A does not: §9 says that
 * overlay is "seeds and lexical top-K without a PPR heat ramp", and the banner
 * is what explains why.
 */
export function fromInspect(
  result: { mode: RetrievalMode; seeds: readonly string[]; ranked: readonly { path: string; score: number }[] },
  k: number,
  question: string,
): Overlay {
  const scores = new Map(result.ranked.map((node) => [node.path, node.score]));
  return {
    source: "inspect",
    seeds: new Set(result.seeds),
    topK: topOf(scores, k),
    scores: result.mode === "B" ? normalize(scores) : null,
    label: `Inspect: ${question}`,
  };
}

/**
 * §9's trace replay.
 *
 * Recorded data only. §9 gives this zero model calls, and the graph the pane is
 * showing may not be the graph the answer saw — so re-running PPR would light
 * what retrieval *would* reach now, which is a different claim from what the
 * note says it did reach.
 */
export function fromTrace(
  resolved: { seeds: readonly string[]; top: readonly { path: string; score: number }[] },
  mode: RetrievalMode,
  unresolved: number,
): Overlay {
  const scores = new Map(resolved.top.map((entry) => [entry.path, entry.score]));
  const missing = unresolved === 0 ? "" : `, ${String(unresolved)} unresolved`;
  return {
    source: "trace",
    seeds: new Set(resolved.seeds),
    topK: new Set(resolved.top.map((entry) => entry.path)),
    scores: mode === "B" ? normalize(scores) : null,
    label: `Retrieval trace (mode ${mode}${missing})`,
  };
}

/**
 * Whether the overlay reaches this node at all.
 *
 * §9 dims "non-neighborhood". A node the walk gave no mass and that is neither
 * a seed nor in the top-K was not reached, whatever the ramp would paint it.
 */
export function isLit(overlay: Overlay, path: string): boolean {
  if (overlay.seeds.has(path) || overlay.topK.has(path)) return true;
  if (overlay.scores === null) return false;
  return (overlay.scores.get(path) ?? 0) > 0;
}

/** Ramp position for a node, 0 when it carries no score. */
export function heatOf(overlay: Overlay, path: string): number {
  return overlay.scores?.get(path) ?? 0;
}

/**
 * §9's filter box: "dims non-matches (no model call)".
 *
 * A plain case-insensitive substring test over the two names a user can see —
 * the title in a label, the path in a tooltip or a link. Nothing is scored and
 * nothing is asked; this is the one interaction §9 names twice as costing no
 * call, and keeping it to `includes` is what makes that obvious rather than
 * argued.
 */
export function matchesFilter(node: SimNode, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return true;
  return (
    node.title.toLowerCase().includes(trimmed) || node.path.toLowerCase().includes(trimmed)
  );
}
