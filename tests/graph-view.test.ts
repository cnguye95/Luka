// §9's pane, to the extent it can be tested without Obsidian.
//
// §14 puts "UI" under a manual checklist, and the `ItemView` itself genuinely
// is manual: lifecycle, canvas painting and CSS-variable sampling need a host.
// But `sim.ts` and `render.ts` were written with no Obsidian import and no DOM
// access precisely so the view could be read for lifecycle and they could be
// read for behaviour — and what is readable in isolation is testable in
// isolation. The camera transform in particular is load-bearing: every §9
// interaction resolves a pointer through it, so a defect there is a defect in
// hover, drag, double-click and every overlay at once.
import { describe, expect, it } from "vitest";
import { colorFor, draw, hitTest, radiusFor, type Frame, type Theme } from "../src/plugin/graph-view/render";
import { createSim, type SimNode } from "../src/plugin/graph-view/sim";
import type { GraphSnapshot } from "../src/core/types";

const THEME: Theme = {
  background: "#000",
  concept: "#c0c0ff",
  entity: "#c0ffc0",
  source: "#ffd0a0",
  raw: "#808080",
  label: "#aaa",
  edge: "#333",
  font: "sans-serif",
};

const node = (path: string, over: Partial<SimNode> = {}): SimNode => ({
  path,
  title: path,
  kind: "concept",
  degree: 0,
  summary: "",
  x: 0,
  y: 0,
  ...over,
});

const frameOf = (nodes: SimNode[], over: Partial<Frame> = {}): Frame => ({
  nodes,
  edges: [],
  camera: { x: 0, y: 0, scale: 1 },
  theme: THEME,
  dpr: 1,
  width: 800,
  height: 600,
  hovered: null,
  ...over,
});

describe("the camera transform, which every interaction resolves through", () => {
  it("finds a node at the screen point its own transform puts it at", () => {
    // graph (10, 20) under scale 2 offset (100, 50) is screen (120, 90).
    // `hitTest` reverses `toScreen`; if the two ever disagree, hover, drag,
    // double-click and every overlay pick the wrong node together.
    const target = node("a.md", { x: 10, y: 20 });
    const frame = frameOf([target], { camera: { x: 100, y: 50, scale: 2 } });

    expect(hitTest(frame, 120, 90)?.path).toBe("a.md");
  });

  it("misses a point the transform does not put the node at", () => {
    const target = node("a.md", { x: 10, y: 20 });
    const frame = frameOf([target], { camera: { x: 100, y: 50, scale: 2 } });

    // The un-transformed coordinates: what a hit test that forgot the camera
    // would answer to.
    expect(hitTest(frame, 10, 20)).toBeNull();
  });

  it("tracks panning and zooming independently", () => {
    const target = node("a.md", { x: 40, y: 0 });

    const panned = frameOf([target], { camera: { x: 7, y: 3, scale: 1 } });
    expect(hitTest(panned, 47, 3)?.path).toBe("a.md");

    const zoomed = frameOf([target], { camera: { x: 0, y: 0, scale: 0.5 } });
    expect(hitTest(zoomed, 20, 0)?.path).toBe("a.md");
    // At half scale the node is no longer where full scale put it.
    expect(hitTest(zoomed, 40, 0)).toBeNull();
  });

  it("picks the node drawn last where two overlap", () => {
    // `draw` paints in array order, so the last one is the one on top and the
    // one a click should get.
    const under = node("under.md", { x: 0, y: 0 });
    const over = node("over.md", { x: 0, y: 0 });

    expect(hitTest(frameOf([under, over]), 0, 0)?.path).toBe("over.md");
  });

  it("answers null when nothing is under the point", () => {
    expect(hitTest(frameOf([node("a.md", { x: 0, y: 0 })]), 900, 900)).toBeNull();
  });
});

describe("§9's visual encoding", () => {
  it("scales radius with log(degree + 1)", () => {
    // §9: "baseline radius ∝ log(degree+1)". Checked as a ratio so the two
    // module-local constants can change without the property changing.
    const growth = (a: number, b: number) =>
      (radiusFor(b) - radiusFor(0)) / (radiusFor(a) - radiusFor(0));

    expect(growth(1, 3)).toBeCloseTo(Math.log(4) / Math.log(2), 12);
    expect(growth(1, 7)).toBeCloseTo(Math.log(8) / Math.log(2), 12);
  });

  it("gives a degree-0 node a visible radius rather than none", () => {
    // An isolated page is still a node §9 draws; a radius of 0 would erase it.
    expect(radiusFor(0)).toBeGreaterThan(0);
  });

  it("grows with degree", () => {
    expect(radiusFor(10)).toBeGreaterThan(radiusFor(1));
    expect(radiusFor(1)).toBeGreaterThan(radiusFor(0));
  });

  it("gives the three wiki kinds and raw four distinct theme colours", () => {
    // §9: "three muted theme-derived colors + one for raw source nodes".
    const used = [
      colorFor("concept", THEME),
      colorFor("entity", THEME),
      colorFor("source", THEME),
      colorFor("raw", THEME),
    ];

    expect(new Set(used).size).toBe(4);
    // Every one comes from the theme rather than a literal in the module.
    for (const colour of used) expect(Object.values(THEME)).toContain(colour);
  });
});

describe("§9's degradation: drop labels first", () => {
  /** A canvas context that records the calls `draw` makes. */
  function recorder() {
    const texts: string[] = [];
    const ctx = {
      texts,
      setTransform: () => undefined,
      fillRect: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      stroke: () => undefined,
      arc: () => undefined,
      fill: () => undefined,
      fillText: (text: string) => texts.push(text),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      globalAlpha: 1,
      font: "",
      textBaseline: "",
    };
    return ctx as unknown as CanvasRenderingContext2D & { texts: string[] };
  }

  const many = (count: number) =>
    Array.from({ length: count }, (_unused, at) =>
      node(`n${String(at).padStart(4, "0")}.md`, { degree: at, x: at, y: 0 }),
    );

  it("labels ten nodes at rest, not one per node", () => {
    const ctx = recorder();

    draw(ctx, frameOf(many(50)));

    expect(ctx.texts).toHaveLength(10);
  });

  it("labels the highest-degree nodes", () => {
    const ctx = recorder();

    draw(ctx, frameOf(many(50)));

    // Degrees run 0..49, so the top ten are 40..49.
    expect(new Set(ctx.texts)).toEqual(
      new Set(Array.from({ length: 10 }, (_u, at) => `n${String(40 + at).padStart(4, "0")}.md`)),
    );
  });

  it("drops the standing labels past 500 nodes", () => {
    const ctx = recorder();

    draw(ctx, frameOf(many(500)));

    expect(ctx.texts).toEqual([]);
  });

  it("keeps the hovered node's label even when the rest are dropped", () => {
    // It answers a gesture the user just made, and it is one string.
    const ctx = recorder();

    draw(ctx, frameOf(many(500), { hovered: "n0007.md" }));

    expect(ctx.texts).toEqual(["n0007.md"]);
  });
});

describe("positions seeded by hashing the page path (§9)", () => {
  const snapshot = (paths: string[]): GraphSnapshot => ({
    nodes: paths.map((path) => ({
      path,
      title: path,
      kind: "concept" as const,
      degree: 1,
      summary: "",
    })),
    edges: [],
  });

  /** Positions as seeded, before any tick moves them. */
  function seeded(paths: string[]): Map<string, string> {
    const sim = createSim(snapshot(paths), () => undefined);
    const at = new Map(sim.nodes.map((n) => [n.path, `${String(n.x)},${String(n.y)}`]));
    sim.stop();
    return at;
  }

  it("puts the same vault in the same place every time", () => {
    // §9 asks for this so a reopened pane starts from the shape the user left.
    expect(seeded(["a.md", "b.md", "c.md"])).toEqual(seeded(["a.md", "b.md", "c.md"]));
  });

  it("does not depend on the order nodes arrive in", () => {
    const forward = seeded(["a.md", "b.md", "c.md"]);
    const backward = seeded(["c.md", "b.md", "a.md"]);

    for (const [path, place] of forward) expect(backward.get(path)).toBe(place);
  });

  it("separates different paths", () => {
    const places = seeded(["a.md", "b.md", "c.md", "d.md", "e.md"]);

    expect(new Set(places.values()).size).toBe(5);
  });

  it("spreads over a disc, not around a ring", () => {
    // Angle and radius come from different halves of the hash. Distinct angles
    // alone would satisfy the test above while every node sat on one circle,
    // which is a layout the force step then has to unpick.
    const paths = Array.from({ length: 40 }, (_u, at) => `wiki/concepts/n${String(at)}.md`);
    const radii = [...seeded(paths).values()].map((place) => {
      const [x, y] = place.split(",").map(Number) as [number, number];
      return Math.hypot(x, y);
    });

    expect(Math.min(...radii)).toBeLessThan(Math.max(...radii) * 0.5);
  });

  it("survives d3's own node initialization", () => {
    // `forceSimulation.nodes()` assigns a phyllotaxis position to any node
    // missing one. If the seed were applied after that call, or dropped, the
    // hash would be decorative and reopening would not reproduce the layout.
    const places = seeded(["wiki/concepts/PageRank.md"]);
    const only = [...places.values()][0] as string;
    const [x, y] = only.split(",").map(Number) as [number, number];

    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
    // d3's spiral puts its first node at radius ~10 on the x axis; the hash
    // puts this one somewhere else entirely.
    expect(Math.hypot(x, y)).toBeGreaterThan(20);
  });
});

describe("a refresh keeps the layout the user is reading (§9)", () => {
  const snapshot = (paths: string[]): GraphSnapshot => ({
    nodes: paths.map((path) => ({
      path,
      title: path,
      kind: "concept" as const,
      degree: 1,
      summary: "",
    })),
    edges: [],
  });

  it("keeps an unpinned survivor where the simulation had moved it to", () => {
    // Deliberately without `fx`/`fy`. d3 copies a pin into `x` on every
    // `nodes()` call, so a pinned node would report the right position even if
    // `replace` had re-seeded it — the pin would be doing the work and the
    // assertion would prove nothing about carrying positions over.
    const sim = createSim(snapshot(["a.md", "b.md"]), () => undefined);
    const before = sim.nodes.find((n) => n.path === "a.md") as SimNode;
    before.x = 123;
    before.y = 456;

    sim.replace(snapshot(["a.md", "b.md", "c.md"]));

    const after = sim.nodes.find((n) => n.path === "a.md") as SimNode;
    expect(after.x).toBe(123);
    expect(after.y).toBe(456);
    sim.stop();
  });

  it("keeps a pin a drag left behind", () => {
    // §9's drag-to-pin: the node stays where it was dropped across a refresh.
    const sim = createSim(snapshot(["a.md"]), () => undefined);
    const before = sim.nodes[0] as SimNode;
    before.fx = 77;
    before.fy = 88;

    sim.replace(snapshot(["a.md", "b.md"]));

    const after = sim.nodes.find((n) => n.path === "a.md") as SimNode;
    expect(after.fx).toBe(77);
    expect(after.fy).toBe(88);
    sim.stop();
  });

  it("hash-seeds a node that was not there before", () => {
    const sim = createSim(snapshot(["a.md"]), () => undefined);
    sim.replace(snapshot(["a.md", "new.md"]));

    const fresh = sim.nodes.find((n) => n.path === "new.md") as SimNode;
    const reference = createSim(snapshot(["new.md"]), () => undefined);
    const alone = reference.nodes[0] as SimNode;

    expect(fresh.x).toBe(alone.x);
    expect(fresh.y).toBe(alone.y);
    sim.stop();
    reference.stop();
  });

  it("drops a node the compile removed", () => {
    const sim = createSim(snapshot(["a.md", "gone.md"]), () => undefined);

    sim.replace(snapshot(["a.md"]));

    expect(sim.nodes.map((n) => n.path)).toEqual(["a.md"]);
    sim.stop();
  });
});
