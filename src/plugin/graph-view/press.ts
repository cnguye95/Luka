// The press half of §9's node gestures: what a press on a node turns out to be.
//
// §9 gives a click and a drag different jobs on the same button — "click a node
// → instant PPR from that node" against "drag-to-pin" beside "drag reheats
// locally" — so something has to decide which of the two a press became, and
// the decision is travel against a threshold. That is pure, so it is here and
// not in `view.ts` among the DOM.
//
// It is a module rather than a few lines inline because *when* the drag starts
// is the whole point. Starting it on `pointerdown`, before any travel is known,
// gave every click both of the drag's side effects: the layout reheated, and
// the node was pinned where it sat — permanently, since `dragEnd` deliberately
// leaves `fx`/`fy` set. The drag begins on the move that passes the threshold
// instead, which is the first moment the gesture is known to be one. Nothing
// here waits: no timer decides anything, and a press that never travels never
// touches the simulation at all.
import type { SimNode } from "./sim";

/** Pointer travel, in CSS pixels, that turns a click into a drag. */
export const CLICK_SLOP = 4;

/**
 * What a press needs of the simulation. `Sim` satisfies it structurally, so
 * this module stays free of `d3-force` as well as of the DOM.
 */
export interface PressSim {
  dragStart(node: SimNode): void;
  dragEnd(): void;
}

/** A press on a node, from `pointerdown` until the pointer is released. */
export interface Press {
  /**
   * The node pressed, as a path and not the object: `sim.replace` allocates
   * fresh `SimNode`s, so a compile landing mid-gesture would leave a held
   * reference pointing at an object no longer in the simulation.
   */
  readonly path: string;
  /** Where the press landed, in canvas pixels. */
  readonly from: { readonly x: number; readonly y: number };
  /** True once travel passed `CLICK_SLOP` and `dragStart` has run. */
  begun: boolean;
}

/** Opens a press at canvas point (`x`, `y`). Touches nothing else yet. */
export function pressOn(path: string, x: number, y: number): Press {
  return { path, from: { x, y }, begun: false };
}

const travelled = (press: Press, x: number, y: number): boolean =>
  Math.hypot(x - press.from.x, y - press.from.y) > CLICK_SLOP;

/**
 * Records a move at canvas point (`x`, `y`), starting the drag if this is the
 * move that passes `CLICK_SLOP`. True once the node should follow the pointer.
 *
 * A press that has not travelled that far is still a candidate click, and it
 * leaves the simulation exactly as it found it: no reheat, no pin.
 */
export function pressMoved(
  press: Press,
  sim: PressSim,
  node: SimNode,
  x: number,
  y: number,
): boolean {
  if (press.begun) return true;
  if (!travelled(press, x, y)) return false;
  sim.dragStart(node);
  press.begun = true;
  return true;
}

/**
 * Ends the press at canvas point (`x`, `y`), returning the path a click-PPR is
 * owed or `null` when the gesture was a drag.
 *
 * Whether the drag began decides that, rather than where the release landed: a
 * drag that wandered back over its own origin is still a drag, and the
 * checklist's §7.6 asks that releasing one does not run click-PPR. The distance
 * is checked too, for the release that carries travel no `pointermove`
 * reported — that is a press that moved, so it is not a click either, and
 * nothing began so nothing ends.
 */
export function pressEnded(press: Press, sim: PressSim, x: number, y: number): string | null {
  if (press.begun) {
    // §9's drag *pins*: `dragEnd` lets the walk cool but leaves `fx`/`fy` set,
    // so the node stays where it was dropped.
    sim.dragEnd();
    return null;
  }
  return travelled(press, x, y) ? null : press.path;
}
