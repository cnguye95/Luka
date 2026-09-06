// §9's iteration scrubber: "when an overlay was computed with snapshots, a
// slider scrubs per-iteration PPR vectors."
//
// The arithmetic of that — which stops exist, which vector each one shows, and
// what the label says — is pure, so it lives here rather than in `view.ts`
// among the DOM, the same split `press.ts` makes for the node gestures.
//
// The one thing worth reading twice is `stopsOf`. §7.2 retains at most 100
// vectors while §17's `pprMaxIterations` can be raised past that, so a long
// walk keeps its first hundred iterations and its final scores with a gap in
// between. The slider has to be able to return to the vector the overlay was
// already showing, so that final vector gets a stop of its own whenever it is
// not the last retained one.
import { normalize, topOf, type Overlay, type Scrub } from "./overlay";
import type { PPRResult } from "../../core/index";

/**
 * What a scrub can be built from: any walk that reports its iterations.
 *
 * Structural rather than `PPRResult` itself, because §9's query inspection
 * hands back the same three fields off an `InspectResult` and there is no
 * reason for one of the two producers to be the special case.
 */
export type Walk = Pick<PPRResult, "scores" | "iterations" | "snapshots">;

/** How many positions the slider has. Always ≥ 1 when a scrub exists. */
export function stopsOf(scrub: Pick<Scrub, "frames" | "iterations">): number {
  return scrub.iterations <= scrub.frames.length ? scrub.frames.length : scrub.frames.length + 1;
}

/** The vector one stop shows: a retained iteration, or the final scores. */
export function vectorAt(scrub: Scrub, at: number): ReadonlyMap<string, number> {
  return scrub.frames[at] ?? scrub.final;
}

/**
 * Attaches the walk's iterations to an overlay, if it kept any.
 *
 * Returns the overlay untouched when there is nothing to scrub — a walk that
 * was not asked for snapshots, or the empty-seed case §7.2 answers with no
 * iterations at all. The slider is then simply absent, which is the state
 * Mode-A inspection and trace replay are always in.
 *
 * The initial stop is the last one, so attaching a scrub changes nothing the
 * user can see: the overlay still shows the converged walk it was built from.
 */
export function withScrub(overlay: Overlay, walk: Walk): Overlay {
  const frames = walk.snapshots;
  if (frames === undefined || frames.length === 0) return overlay;
  const scrub: Scrub = {
    frames,
    final: walk.scores,
    iterations: walk.iterations,
    at: 0,
  };
  return { ...overlay, scrub: { ...scrub, at: stopsOf(scrub) - 1 } };
}

/**
 * The same overlay, showing the walk as it stood at one iteration.
 *
 * Both of §9's score-driven marks move: the heat ramp because that is the
 * point, and the top-K stroke because a ranking pinned to the converged walk
 * would claim the early iterations had already chosen their winners. Each
 * frame is normalized against its own peak (S32 applied per vector), so the
 * ramp answers "where was the mass then", not "how far along was this".
 *
 * A new object every time. The frames array is shared rather than copied —
 * it is read-only and can be a hundred maps.
 */
export function scrubTo(overlay: Overlay, at: number, k: number): Overlay {
  const scrub = overlay.scrub;
  if (scrub === undefined || !Number.isFinite(at)) return overlay;
  const stop = Math.min(Math.max(Math.floor(at), 0), stopsOf(scrub) - 1);
  const vector = vectorAt(scrub, stop);
  return {
    ...overlay,
    topK: topOf(vector, k),
    scores: normalize(vector),
    scrub: { ...scrub, at: stop },
  };
}

/**
 * What the slider says it is showing.
 *
 * Iterations are reported 1-based because that is how §7.2 counts them and how
 * `PPRResult.iterations` reports them. The third form only arises when the
 * retention cap cut the middle out of a long walk, and it names the gap rather
 * than letting the slider imply it stepped through iterations nobody kept.
 */
export function scrubLabel(scrub: Scrub): string {
  const total = String(scrub.iterations);
  if (scrub.at < scrub.frames.length) return `iteration ${String(scrub.at + 1)} of ${total}`;
  if (scrub.iterations === scrub.frames.length + 1) return `iteration ${total} of ${total}`;
  const first = String(scrub.frames.length + 1);
  const last = String(scrub.iterations - 1);
  return `final vector at iteration ${total} (iterations ${first}–${last} not retained)`;
}
