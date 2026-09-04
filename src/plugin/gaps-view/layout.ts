// The card glyph, as geometry and nothing else.
//
// No DOM and no Obsidian import, for the reason `sim.ts` has none: what is
// readable in isolation is testable in isolation, and vitest runs in a node
// environment where a value import from `obsidian` does not resolve at all.
// `glyph.ts` turns these shapes into elements; this decides what they are.
//
// Deterministic by construction — no simulation, no hashing, no randomness.
// A card that redrew differently each time it was rendered would be a card the
// user could not compare against the one beside it.
import type { GapKind } from "../../core/index";

/** The glyph's square side, in user units. The card's CSS decides its pixels. */
export const GLYPH_SIZE = 96;

/**
 * How many nodes the ring shows before it becomes "+k more".
 *
 * Past roughly eight spokes a ring reads as "many" rather than as a count, and
 * counting is the whole job — so the overflow label carries the rest as a
 * number instead of drawing them as indistinguishable dots.
 */
export const RING_CAP = 8;

/** Ring radius as a fraction of the side: leaves room for the overflow label. */
const RING_RATIO = 0.36;

export interface Point {
  x: number;
  y: number;
}

export interface RadialLayout {
  size: number;
  centre: Point;
  ring: Point[];
  /** How many nodes the ring could not show. */
  overflow: number;
}

/**
 * The ghost at the centre, everything that wants it on a ring around it.
 *
 * The first point sits at twelve o'clock and the rest run clockwise, so the
 * commonest case — two pages wanting one article — is vertically symmetric
 * rather than tilted.
 */
export function radialLayout(count: number, options: { size: number; cap: number }): RadialLayout {
  const { size, cap } = options;
  const centre = { x: size / 2, y: size / 2 };
  const shown = Math.max(0, Math.min(count, cap));
  const radius = size * RING_RATIO;

  const ring: Point[] = [];
  for (let at = 0; at < shown; at++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * at) / shown;
    ring.push({ x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius });
  }

  return { size, centre, ring, overflow: Math.max(0, count - shown) };
}

export interface Shape {
  tag: "circle" | "line" | "text";
  attr: Record<string, string>;
  /** Text content, for the overflow label. `SvgElementInfo` has no text field. */
  text?: string;
  /** A `<title>` child, which is how an SVG node gets a hover name. */
  title?: string;
}

/**
 * Every colour here is a CSS variable with a fallback, and the fallbacks are
 * `render.ts`'s own. Two reasons: the graph pane samples those variables at
 * draw time so the two panes agree about what a concept looks like, and
 * `sampleTheme` carries hex fallbacks precisely because a third-party theme
 * need not define `--color-blue`. A bare `var(--color-blue)` renders as
 * nothing when the variable is absent.
 */
const EDGE = "var(--text-faint, #6b6b6b)";
const NODE = "var(--text-muted, #9a9a9a)";
const GHOST = "var(--interactive-accent, #7f6df2)";
const SOLID = "var(--color-blue, #5b8def)";

/** Matches `render.ts`'s EDGE_ALPHA, so an edge reads the same weight in both. */
const EDGE_OPACITY = "0.45";

export function glyphShapes(
  kind: GapKind,
  labels: readonly string[],
  layout: RadialLayout,
): Shape[] {
  const shapes: Shape[] = [];
  const { centre, ring, size, overflow } = layout;

  // Edges first, so a node is never drawn under one.
  for (const point of ring) {
    shapes.push({
      tag: "line",
      attr: {
        x1: round(centre.x),
        y1: round(centre.y),
        x2: round(point.x),
        y2: round(point.y),
        stroke: EDGE,
        "stroke-opacity": EDGE_OPACITY,
        // Dashed: the edge does not exist yet either. It is what the vault
        // gains when the article is written, which is the whole picture.
        ...(kind === "article" ? { "stroke-dasharray": "3 2" } : {}),
      },
    });
  }

  shapes.push({
    tag: "circle",
    attr:
      kind === "article"
        ? {
            cx: round(centre.x),
            cy: round(centre.y),
            r: "7",
            // Hollow and dashed: this is the page that is not there.
            fill: "none",
            stroke: GHOST,
            "stroke-width": "1.5",
            "stroke-dasharray": "3 2",
          }
        : {
            cx: round(centre.x),
            cy: round(centre.y),
            r: "7",
            // The thin page exists; what it lacks is a second source.
            fill: SOLID,
          },
  });

  ring.forEach((point, at) => {
    const label = labels[at];
    shapes.push({
      tag: "circle",
      attr: { cx: round(point.x), cy: round(point.y), r: "4", fill: NODE },
      ...(label === undefined ? {} : { title: label }),
    });
  });

  if (overflow > 0) {
    shapes.push({
      tag: "text",
      attr: {
        x: round(centre.x),
        y: round(size - 4),
        "text-anchor": "middle",
        "font-size": "10",
        fill: NODE,
      },
      text: `+${String(overflow)} more`,
    });
  }

  return shapes;
}

/** Two decimals: enough for a 96-unit box, and stable across engines. */
function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}
