// Drawing: Canvas 2D, with colors and fonts from Obsidian CSS variables. Node
// color is by kind (three muted theme-derived colors + one for raw source
// nodes), baseline radius ∝ log(degree+1), labels on hover plus top-10 by
// current metric. Degradation drops labels first.
//
// Pure: `draw` takes a frame and paints it, `hitTest` reverses the same camera
// transform. Nothing here reads the vault, the core, or the clock, so what the
// pane shows is a function of what it was handed.
import { heatOf, isLit, matchesFilter, type Overlay } from "./overlay";
import type { SimNode } from "./sim";

/**
 * Render constants. Only the label count and the 500-node figure are fixed,
 * so the rest take the smallest option: module-local.
 */
const RADIUS_BASE = 3;
const RADIUS_SCALE = 2.6;
/** Labels on hover plus top-10 by current metric. */
const LABEL_LIMIT = 10;
/** Target smooth pan/zoom at 500+ nodes, and drop labels first. */
const LABEL_DROP_THRESHOLD = 500;
const LABEL_OFFSET = 4;
/**
 * Edges carry the structure — PPR runs on them — so they have to be readable,
 * not merely present. `--background-modifier-border` is Obsidian's subtle
 * divider, ~28/255 off `--background-primary`; at any alpha below 1 it paints a
 * line the eye cannot find, and a connected node reads as isolated. The colour
 * moved to `--text-faint` (below) and the alpha rose with it: together they put
 * the line at ~1.6 contrast against the background in both themes, a hairline
 * that is visible without competing with the nodes it connects.
 */
const EDGE_ALPHA = 0.45;
/** Dimming: the overlay's non-neighborhood, the filter's non-matches. */
const DIM_OPACITY = 0.15;
const TOP_K_STROKE = 2;
const SEED_RING_WIDTH = 2;
const SEED_RING_GAP = 3;

export interface Theme {
  background: string;
  /** Three muted kind colors plus one for raw sources. */
  concept: string;
  entity: string;
  source: string;
  raw: string;
  label: string;
  edge: string;
  /** The hot end of the heat ramp, and the seed ring / top-K stroke. */
  accent: string;
  heat: string;
  font: string;
}

export interface Camera {
  /** Canvas-space translation, in CSS pixels. */
  x: number;
  y: number;
  scale: number;
}

export interface Frame {
  nodes: readonly SimNode[];
  edges: readonly { a: string; b: string }[];
  camera: Camera;
  theme: Theme;
  /** Device pixel ratio the canvas backing store was sized for. */
  dpr: number;
  width: number;
  height: number;
  hovered: string | null;
  /** The overlay, or `null` for the baseline view. */
  overlay: Overlay | null;
  /** The filter box text. Empty matches everything. */
  filter: string;
}

/**
 * Reads the pane's colors out of the theme in force.
 *
 * Sampled per redraw rather than cached at open, so switching dark↔light is
 * picked up without reopening the pane. `getComputedStyle` resolves the
 * variable to a concrete color, so canvas gets something it can paint rather
 * than a `var(...)` string it would ignore.
 */
export function sampleTheme(el: HTMLElement): Theme {
  const style = getComputedStyle(el);
  const read = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value === "" ? fallback : value;
  };
  return {
    background: read("--background-primary", "#1e1e1e"),
    concept: read("--color-blue", "#5b8def"),
    entity: read("--color-green", "#4caf7d"),
    source: read("--color-orange", "#d99045"),
    raw: read("--text-faint", "#6b6b6b"),
    label: read("--text-muted", "#9a9a9a"),
    edge: read("--text-faint", "#6b6b6b"),
    accent: read("--interactive-accent", "#7f6df2"),
    heat: read("--color-red", "#e05252"),
    font: read("--font-interface", "sans-serif"),
  };
}

export function colorFor(kind: string, theme: Theme): string {
  switch (kind) {
    case "concept":
      return theme.concept;
    case "entity":
      return theme.entity;
    case "source":
      return theme.source;
    default:
      return theme.raw;
  }
}

/** Baseline radius ∝ log(degree+1). */
export function radiusFor(degree: number): number {
  return RADIUS_BASE + RADIUS_SCALE * Math.log(degree + 1);
}

/**
 * How visible a node is: the overlay and the filter dim independently.
 *
 * They are separate controls — the filter dims non-matches whatever the
 * overlay shows, and the overlay dims everything outside its neighborhood
 * whatever the filter holds — so a node outside both is dimmer than one outside
 * either. Multiplying is what makes the two readable at once; taking a minimum
 * would make the second one applied invisible.
 */
export function opacityOf(node: SimNode, frame: Frame): number {
  const byOverlay = frame.overlay === null || isLit(frame.overlay, node.path) ? 1 : DIM_OPACITY;
  const byFilter = matchesFilter(node, frame.filter) ? 1 : DIM_OPACITY;
  return byOverlay * byFilter;
}

/** Mixes two `#rrggbb` colours; anything else falls back to the destination. */
function rampBetween(from: string, to: string, position: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (a === null || b === null) return position > 0 ? to : from;
  const at = Math.min(1, Math.max(0, position));
  const mix = (low: number, high: number) => Math.round(low + (high - low) * at);
  return `rgb(${String(mix(a[0], b[0]))}, ${String(mix(a[1], b[1]))}, ${String(mix(a[2], b[2]))})`;
}

function parseHex(colour: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (match === null) return null;
  const value = parseInt(match[1] as string, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Graph space → canvas space, the transform `hitTest` reverses. */
function toScreen(node: SimNode, camera: Camera): { x: number; y: number } {
  return {
    x: (node.x ?? 0) * camera.scale + camera.x,
    y: (node.y ?? 0) * camera.scale + camera.y,
  };
}

/**
 * Canvas space → graph space: `toScreen`'s inverse.
 *
 * Lives beside it deliberately. Zoom-about-cursor and drag both need to undo
 * the transform, and a second copy of the arithmetic in the view is a copy that
 * can drift from the one the drawing uses — which is the same coupling
 * `hitTest` exists to keep honest.
 */
export function toGraph(camera: Camera, x: number, y: number): { x: number; y: number } {
  return { x: (x - camera.x) / camera.scale, y: (y - camera.y) / camera.scale };
}

/**
 * The nodes that get a standing label: the top ten by the current metric.
 *
 * The "current metric" is degree until an overlay supplies scores; the overlay
 * steps replace this selection rather than adding a second one.
 */
function labelled(nodes: readonly SimNode[], overlay: Overlay | null): Set<string> {
  // The metric is the overlay's scores when it has them, degree otherwise. An
  // earlier version took only `nodes` and ranked by degree unconditionally,
  // while this comment claimed the overlay replaced the selection — so under a
  // PPR or Inspect overlay the ten labels stayed on the ten highest-degree
  // hubs, which is what every query shares. The one moment the names matter is
  // the one where they were least informative.
  const metric = (node: SimNode): number =>
    overlay === null || overlay.scores === null ? node.degree : heatOf(overlay, node.path);
  const ranked = [...nodes]
    // A score-less overlay — Mode-A inspection — still narrows *which*
    // nodes can be labelled, even though it cannot reorder them.
    .filter((node) => overlay === null || isLit(overlay, node.path))
    .sort((a, b) => metric(b) - metric(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, LABEL_LIMIT);
  return new Set(ranked.map((node) => node.path));
}

export function draw(ctx: CanvasRenderingContext2D, frame: Frame): void {
  const { camera, theme, nodes } = frame;

  ctx.setTransform(frame.dpr, 0, 0, frame.dpr, 0, 0);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, frame.width, frame.height);

  const byPath = new Map(nodes.map((node) => [node.path, node]));

  ctx.strokeStyle = theme.edge;
  ctx.globalAlpha = EDGE_ALPHA;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const edge of frame.edges) {
    const a = byPath.get(edge.a);
    const b = byPath.get(edge.b);
    if (a === undefined || b === undefined) continue;
    const from = toScreen(a, camera);
    const to = toScreen(b, camera);
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  for (const node of nodes) {
    const at = toScreen(node, camera);
    const radius = radiusFor(node.degree) * camera.scale;

    ctx.globalAlpha = opacityOf(node, frame);
    // The heat ramp replaces the kind colour where a score reaches the node;
    // without an overlay, or where it does not reach, the kind colour stands.
    ctx.fillStyle =
      frame.overlay === null || frame.overlay.scores === null
        ? colorFor(node.kind, theme)
        : rampBetween(colorFor(node.kind, theme), theme.heat, heatOf(frame.overlay, node.path));
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
    ctx.fill();

    if (frame.overlay !== null) {
      // Ring = seeds, stroke = top-K. A node can be both, and then it
      // carries both marks — the ring sits outside the stroke.
      if (frame.overlay.topK.has(node.path)) {
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = TOP_K_STROKE;
        ctx.beginPath();
        ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (frame.overlay.seeds.has(node.path)) {
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = SEED_RING_WIDTH;
        ctx.beginPath();
        ctx.arc(at.x, at.y, radius + SEED_RING_GAP, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;

  // Degradation drops labels first. The hovered node keeps its label —
  // it is the answer to a gesture the user just made, and it is one string.
  const standing =
    nodes.length >= LABEL_DROP_THRESHOLD ? new Set<string>() : labelled(nodes, frame.overlay);
  if (standing.size === 0 && frame.hovered === null) return;

  ctx.fillStyle = theme.label;
  ctx.font = `12px ${theme.font}`;
  ctx.textBaseline = "middle";
  for (const node of nodes) {
    if (!standing.has(node.path) && node.path !== frame.hovered) continue;
    const at = toScreen(node, camera);
    ctx.fillText(node.title, at.x + radiusFor(node.degree) * camera.scale + LABEL_OFFSET, at.y);
  }
}

/**
 * The topmost node under a canvas-space point, or `null`.
 *
 * Reverses `toScreen` rather than reimplementing it, and walks backwards so the
 * node drawn last — the one visibly on top — is the one picked.
 */
export function hitTest(frame: Frame, x: number, y: number): SimNode | null {
  for (let at = frame.nodes.length - 1; at >= 0; at--) {
    const node = frame.nodes[at] as SimNode;
    const screen = toScreen(node, frame.camera);
    const radius = radiusFor(node.degree) * frame.camera.scale;
    const dx = x - screen.x;
    const dy = y - screen.y;
    // A generous target: nodes are small, and there is hover, drag and
    // double-click on all of them.
    const reach = Math.max(radius, 6);
    if (dx * dx + dy * dy <= reach * reach) return node;
  }
  return null;
}
