// The glyph's shapes, as elements.
//
// Separated from `layout.ts` for the reason `render.ts` is separated from
// `view.ts`: the geometry is testable without a host, this is not. Everything
// here is `createSvg` and attribute setting — no measurement, no theme
// sampling, no listener. A glyph is inert.
//
// SVG rather than a canvas, unlike §9's pane, and for reasons that only apply
// to a card: colours can be CSS variables directly, so a theme switch needs no
// repaint and no `css-change` listener; dashed strokes are native, and the
// ghost node and its edges are dashed; there is no simulation to run, so no
// timer; and forty small canvases would each need their own context, backing
// store and device-ratio handling.
import { GLYPH_SIZE, RING_CAP, glyphShapes, radialLayout } from "./layout";
import type { GapKind } from "../../core/index";

/**
 * Draws one card's glyph into `parent` and returns it.
 *
 * No event listener is attached to anything here: Obsidian's `registerDomEvent`
 * takes an `HTMLElement`, and every element below is an `SVGElement`. The
 * card's buttons are HTML for that reason.
 */
export function drawGlyph(
  parent: HTMLElement,
  kind: GapKind,
  labels: readonly string[],
  label: string,
): SVGSVGElement {
  const layout = radialLayout(labels.length, { size: GLYPH_SIZE, cap: RING_CAP });
  const svg = parent.createSvg("svg", {
    cls: "luka-gap-glyph-svg",
    attr: {
      viewBox: `0 0 ${String(GLYPH_SIZE)} ${String(GLYPH_SIZE)}`,
      role: "img",
      "aria-label": label,
    },
  });

  for (const shape of glyphShapes(kind, labels, layout)) {
    const el = svg.createSvg(shape.tag, { attr: shape.attr });
    // `SvgElementInfo` has no `text` field, unlike its HTML sibling.
    if (shape.text !== undefined) el.textContent = shape.text;
    if (shape.title !== undefined) el.createSvg("title").textContent = shape.title;
  }

  return svg;
}
