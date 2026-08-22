// §9's drawing: Canvas 2D, "colors and fonts from Obsidian CSS variables",
// "node color by kind (three muted theme-derived colors + one for raw source
// nodes), baseline radius ∝ log(degree+1), labels on hover plus top-10 by
// current metric", and "degradation: drop labels first".
//
// Pure: `draw` takes a frame and paints it, `hitTest` reverses the same camera
// transform. Nothing here reads the vault, the core, or the clock, so what the
// pane shows is a function of what it was handed.
import type { SimNode } from "./sim";

/**
 * Render constants. §17 names none of these; §9 fixes only the label count and
 * the 500-node figure, so the rest are §0's smallest option: module-local.
 */
const RADIUS_BASE = 3;
const RADIUS_SCALE = 2.6;
/** §9: "labels on hover plus top-10 by current metric". */
const LABEL_LIMIT = 10;
/** §9: "target smooth pan/zoom at 500+ nodes", and "drop labels first". */
const LABEL_DROP_THRESHOLD = 500;
const LABEL_OFFSET = 4;
const EDGE_ALPHA = 0.25;

export interface Theme {
  background: string;
  /** Three muted kind colors plus one for raw sources (§9). */
  concept: string;
  entity: string;
  source: string;
  raw: string;
  label: string;
  edge: string;
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
}

/**
 * Reads §9's colors out of the theme in force.
 *
 * Sampled per redraw rather than cached at open, so switching dark↔light is
 * picked up without reopening the pane — which is what §15's AC asks for.
 * `getComputedStyle` resolves the variable to a concrete color, so canvas gets
 * something it can paint rather than a `var(...)` string it would ignore.
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
    edge: read("--background-modifier-border", "#3a3a3a"),
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

/** §9: "baseline radius ∝ log(degree+1)". */
export function radiusFor(degree: number): number {
  return RADIUS_BASE + RADIUS_SCALE * Math.log(degree + 1);
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
 * The nodes that get a standing label: the top ten by degree.
 *
 * §9's "current metric" is degree until an overlay supplies scores; the overlay
 * steps replace this selection rather than adding a second one.
 */
function labelled(nodes: readonly SimNode[]): Set<string> {
  const ranked = [...nodes]
    .sort((a, b) => b.degree - a.degree || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
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
    ctx.fillStyle = colorFor(node.kind, theme);
    ctx.beginPath();
    ctx.arc(at.x, at.y, radiusFor(node.degree) * camera.scale, 0, Math.PI * 2);
    ctx.fill();
  }

  // §9's degradation: "drop labels first". The hovered node keeps its label —
  // it is the answer to a gesture the user just made, and it is one string.
  const standing = nodes.length >= LABEL_DROP_THRESHOLD ? new Set<string>() : labelled(nodes);
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
    // A generous target: nodes are small, and §9 asks for hover, drag and
    // double-click on all of them.
    const reach = Math.max(radius, 6);
    if (dx * dx + dy * dy <= reach * reach) return node;
  }
  return null;
}
