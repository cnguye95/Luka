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
import {
  colorFor,
  draw,
  hitTest,
  opacityOf,
  radiusFor,
  toGraph,
  type Frame,
  type Theme,
} from "../src/plugin/graph-view/render";
import {
  fromClickPPR,
  fromInspect,
  fromTrace,
  heatOf,
  isLit,
  matchesFilter,
} from "../src/plugin/graph-view/overlay";
import {
  CLICK_SLOP,
  pressEnded,
  pressMoved,
  pressOn,
  type Press,
} from "../src/plugin/graph-view/press";
import { createSim, sameTopology, type Sim, type SimNode } from "../src/plugin/graph-view/sim";
import type { GraphSnapshot } from "../src/core/types";

const THEME: Theme = {
  background: "#000",
  concept: "#c0c0ff",
  entity: "#c0ffc0",
  source: "#ffd0a0",
  raw: "#808080",
  label: "#aaa",
  edge: "#333",
  accent: "#ff00ff",
  heat: "#ff0000",
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
  overlay: null,
  filter: "",
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

describe("the inverse transform, which drag and zoom-about-cursor need", () => {
  it("undoes the forward transform for any camera", () => {
    // `toGraph` is `toScreen` backwards. A drag reads a pointer through it and
    // writes the result straight into a node's position, so an inverse that is
    // off by the camera puts the node somewhere the user did not drop it.
    for (const camera of [
      { x: 0, y: 0, scale: 1 },
      { x: 100, y: 50, scale: 2 },
      { x: -30, y: 12, scale: 0.35 },
    ]) {
      const target = node("a.md", { x: 17, y: -23 });
      const frame = frameOf([target], { camera });
      // Find where the forward transform put it, by asking the hit test.
      const screen = {
        x: 17 * camera.scale + camera.x,
        y: -23 * camera.scale + camera.y,
      };
      expect(hitTest(frame, screen.x, screen.y)?.path).toBe("a.md");

      const back = toGraph(camera, screen.x, screen.y);
      expect(back.x).toBeCloseTo(17, 10);
      expect(back.y).toBeCloseTo(-23, 10);
    }
  });

  it("keeps the point under the cursor fixed when the scale changes", () => {
    // What zoom-about-cursor is: the graph point beneath the pointer must be
    // the same before and after. The view recomputes the camera offset from
    // this, so if the inverse were wrong the graph would slide under the mouse.
    const camera = { x: 40, y: 90, scale: 1.4 };
    const cursor = { x: 220, y: 160 };

    const before = toGraph(camera, cursor.x, cursor.y);
    const scale = camera.scale * 1.8;
    const moved = { scale, x: cursor.x - before.x * scale, y: cursor.y - before.y * scale };
    const after = toGraph(moved, cursor.x, cursor.y);

    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
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

describe("edges are drawn to be seen, not merely drawn", () => {
  // The pane exists to show why retrieval ranked what it did, and PPR runs on
  // the edges. Edges once used `--background-modifier-border` at alpha 0.25:
  // Obsidian's subtle divider is ~28/255 off the background, so the composite
  // landed at 1.09 contrast and a node genuinely inside the giant component
  // read as isolated. This pins the property that failed — the composited line
  // stands off the background — rather than the alpha that happens to satisfy
  // it, so it survives a retune and fails a revert.
  //
  // It cannot cover the other half of that fix. Which CSS variable `edge` is
  // sampled from lives in `sampleTheme`, which needs `getComputedStyle`; this
  // suite runs under vitest's `node` environment. Picking a near-background
  // variable again stays a manual check (README §6).
  const MIN_CONTRAST = 1.45;

  /** Records the alpha and stroke colour in force when the edges are stroked. */
  function edgeStroke(theme: Theme): { alpha: number; color: string } {
    let seen: { alpha: number; color: string } | null = null;
    const ctx = {
      setTransform: () => undefined,
      fillRect: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      // `draw` strokes the whole edge set once, before any node is painted.
      stroke: () => {
        seen ??= { alpha: ctx.globalAlpha, color: ctx.strokeStyle };
      },
      arc: () => undefined,
      fill: () => undefined,
      fillText: () => undefined,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      globalAlpha: 1,
      font: "",
      textBaseline: "",
    };
    draw(ctx as unknown as CanvasRenderingContext2D, {
      ...frameOf([node("a.md", { x: 0, y: 0 }), node("b.md", { x: 40, y: 40 })], {
        edges: [{ a: "a.md", b: "b.md" }],
      }),
      theme,
    });
    if (seen === null) throw new Error("draw never stroked the edges");
    return seen;
  }

  const rgb = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];

  /** WCAG relative luminance. */
  const luminance = (color: [number, number, number]): number => {
    const channel = (v: number): number => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
  };

  /** The contrast an edge actually reaches once alpha has flattened it onto the background. */
  function composited(theme: Theme): number {
    const { alpha, color } = edgeStroke(theme);
    const back = rgb(theme.background);
    const front = rgb(color);
    const flat = back.map((c, at) => c + (front[at] - c) * alpha) as [number, number, number];
    const a = luminance(back);
    const b = luminance(flat);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  // Obsidian's default themes, near enough: `--background-primary` and the
  // `--text-faint` the edge colour is sampled from.
  it("stands off the background on the default dark theme", () => {
    expect(
      composited({ ...THEME, background: "#1e1e1e", edge: "#6b6b6b" }),
    ).toBeGreaterThan(MIN_CONTRAST);
  });

  it("stands off the background on the default light theme", () => {
    expect(
      composited({ ...THEME, background: "#ffffff", edge: "#999999" }),
    ).toBeGreaterThan(MIN_CONTRAST);
  });

  it("still paints edges with the theme's edge colour, not a fixed hue", () => {
    // §9: "colors and fonts from Obsidian CSS variables". Whatever the theme
    // hands over is what reaches the canvas.
    expect(edgeStroke({ ...THEME, edge: "#123456" }).color).toBe("#123456");
  });

  it("leaves the background opaque, so the PNG export is not transparent", () => {
    // The export draws the same frame onto a fresh canvas, where globalAlpha
    // starts at 1; the edge alpha must not have leaked onto the fillRect.
    const order: string[] = [];
    const ctx = {
      setTransform: () => undefined,
      fillRect: () => order.push(`fillRect@${ctx.globalAlpha}`),
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      stroke: () => undefined,
      arc: () => undefined,
      fill: () => undefined,
      fillText: () => undefined,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      globalAlpha: 1,
      font: "",
      textBaseline: "",
    };
    draw(
      ctx as unknown as CanvasRenderingContext2D,
      frameOf([node("a.md"), node("b.md", { x: 40 })], { edges: [{ a: "a.md", b: "b.md" }] }),
    );

    expect(order).toEqual(["fillRect@1"]);
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
  const snapshot = (
    paths: string[],
    edges: [string, string][] = [],
    over: Partial<{ kind: string; summary: string; title: string; degree: number }> = {},
  ): GraphSnapshot => ({
    nodes: paths.map((path) => ({
      path,
      title: over.title ?? path,
      kind: (over.kind ?? "concept") as "concept",
      degree: over.degree ?? 1,
      summary: over.summary ?? "",
    })),
    edges: edges.map(([a, b]) => ({ a, b })),
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

  it("leaves a settled layout at the temperature it had settled to", () => {
    // §14's finding: a compile reporting "nothing to do" rearranged a settled
    // layout. Asserted on `alpha` rather than on the return value, because a
    // `replace` that reheats and reports `false` is the same defect wearing a
    // correct answer — and that is exactly what the boolean cannot see.
    // `alpha(x)` assigns synchronously and `restart()` only schedules d3's
    // timer for a later turn, so this reads what `replace` left.
    const same = () => snapshot(["a.md", "b.md"], [["a.md", "b.md"]]);
    const sim = createSim(same(), () => undefined);
    const fresh = sim.alpha;
    // Cool it off its starting value, so a reheat has something to undo.
    sim.tick();
    const settled = sim.alpha;
    expect(settled).toBeLessThan(fresh);

    expect(sim.replace(same())).toBe(false);

    expect(sim.alpha).toBe(settled);
    sim.stop();
  });

  it("reheats when a node arrives, a node leaves, or an edge changes", () => {
    const sim = createSim(snapshot(["a.md", "b.md"], [["a.md", "b.md"]]), () => undefined);
    const fresh = sim.alpha;

    for (const next of [
      snapshot(["a.md", "b.md", "c.md"], [["a.md", "b.md"]]),
      snapshot(["a.md", "b.md"], [["a.md", "b.md"]]),
      snapshot(["a.md", "b.md"]),
    ]) {
      sim.tick();
      expect(sim.alpha).toBeLessThan(fresh);
      expect(sim.replace(next)).toBe(true);
      expect(sim.alpha).toBe(fresh);
    }
    sim.stop();
  });

  it("reheats for a rename: the same counts, a different path", () => {
    // A §6.5 rename retitles one page: one node leaves and one arrives, so the
    // counts match and only the paths differ. It is a new layout and must be
    // treated as one — and it is the only shape that reaches `sameTopology`'s
    // node comparison, since every other case is caught by the length guard.
    const sim = createSim(snapshot(["a.md", "b.md"]), () => undefined);
    sim.tick();

    expect(sim.replace(snapshot(["a.md", "c.md"]))).toBe(true);

    expect(sim.nodeAt("c.md")).toBeDefined();
    expect(sim.nodeAt("b.md")).toBeUndefined();
    expect(sameTopology(snapshot(["a.md", "b.md"]), snapshot(["a.md", "c.md"]))).toBe(false);
    sim.stop();
  });

  it("carries every field the tooltip reads onto a node it did not reheat", () => {
    // A compile that rewrote prose changes what the tooltip should say without
    // changing the topology. Skipping the reheat must not also skip the update.
    const sim = createSim(snapshot(["a.md"], []), () => undefined);
    const before = sim.nodes[0] as SimNode;
    before.x = 123;
    before.y = 456;

    const reheated = sim.replace(
      snapshot(["a.md"], [], { kind: "entity", summary: "Rewritten.", title: "Renamed", degree: 7 }),
    );

    const after = sim.nodeAt("a.md") as SimNode;
    expect(reheated).toBe(false);
    expect(after.summary).toBe("Rewritten.");
    expect(after.kind).toBe("entity");
    expect(after.title).toBe("Renamed");
    expect(after.degree).toBe(7);
    expect(after.x).toBe(123);
    expect(after.y).toBe(456);
    sim.stop();
  });

  it("keeps a pin across a replace it did not reheat", () => {
    const sim = createSim(snapshot(["a.md"]), () => undefined);
    const before = sim.nodes[0] as SimNode;
    before.fx = 77;
    before.fy = 88;

    expect(sim.replace(snapshot(["a.md"]))).toBe(false);

    const after = sim.nodeAt("a.md") as SimNode;
    expect(after.fx).toBe(77);
    expect(after.fy).toBe(88);
    sim.stop();
  });

  describe("sameTopology", () => {
    it("tells equal snapshots from ones differing only in an edge endpoint", () => {
      const one = snapshot(["a.md", "b.md", "c.md"], [["a.md", "b.md"]]);

      expect(sameTopology(one, snapshot(["a.md", "b.md", "c.md"], [["a.md", "b.md"]]))).toBe(true);
      // Each end separately: an edge pair is two values and comparing one of
      // them would pass every fixture that only ever varies the other.
      expect(sameTopology(one, snapshot(["a.md", "b.md", "c.md"], [["a.md", "c.md"]]))).toBe(false);
      expect(sameTopology(one, snapshot(["a.md", "b.md", "c.md"], [["c.md", "b.md"]]))).toBe(false);
    });

    it("is false when the counts differ", () => {
      const one = snapshot(["a.md"], []);

      expect(sameTopology(one, snapshot(["a.md", "b.md"], []))).toBe(false);
      expect(sameTopology(one, snapshot(["a.md"], [["a.md", "a.md"]]))).toBe(false);
    });

    it("ignores everything the layout does not depend on", () => {
      // Same paths and pairs, different metadata: still the same topology, so
      // still no reheat — the carry-over above is what keeps it correct.
      const one = snapshot(["a.md"], []);
      const other = snapshot(["a.md"], [], { kind: "entity", summary: "New.", title: "Other" });

      expect(sameTopology(one, other)).toBe(true);
    });
  });
});

describe("what a press on a node turns out to be (§9's click against its drag)", () => {
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

  /** A live simulation, the node under the press, and the press — as the view
   * holds them between `pointerdown` and the release. */
  function pressed(): { sim: Sim; node: SimNode; press: Press } {
    const sim = createSim(snapshot(["a.md", "b.md"]), () => undefined);
    const node = sim.nodeAt("a.md") as SimNode;
    return { sim, node, press: pressOn("a.md", 100, 100) };
  }

  it("starts nothing on the press itself", () => {
    // Where the defect lived: `dragStart` ran on `pointerdown`, before anything
    // knew which of §9's two gestures this was going to be.
    const { sim, node } = pressed();

    expect(node.fx).toBeUndefined();
    expect(node.fy).toBeUndefined();
    expect(sim.heldAlpha).toBe(0);
    sim.stop();
  });

  it("does not pin a node the pointer only rested on", () => {
    const { sim, node, press } = pressed();

    pressMoved(press, sim, node, 100 + CLICK_SLOP, 100);

    expect(press.begun).toBe(false);
    expect(node.fx).toBeUndefined();
    expect(node.fy).toBeUndefined();
    sim.stop();
  });

  it("neither reheats nor pins for a click, and still owes it a PPR", () => {
    // §9 gives a click one job, an instant PPR overlay. The other two are the
    // drag's, and the pin is the one that accumulates: ten clicks while
    // exploring froze ten nodes, and the layout could not relax again.
    const { sim, node, press } = pressed();

    pressMoved(press, sim, node, 102, 101);
    const clicked = pressEnded(press, sim, 102, 101);

    expect(clicked).toBe("a.md");
    expect(node.fx).toBeUndefined();
    expect(node.fy).toBeUndefined();
    expect(sim.heldAlpha).toBe(0);
    sim.stop();
  });

  it("begins the drag on the first move past the slop, and not on the one at it", () => {
    // Pinned from both sides: a threshold tested only from beyond it is
    // satisfied by any smaller one, including the zero the defect had.
    const { sim, node, press } = pressed();

    expect(pressMoved(press, sim, node, 100 + CLICK_SLOP, 100)).toBe(false);
    expect(node.fx).toBeUndefined();

    expect(pressMoved(press, sim, node, 100 + CLICK_SLOP + 1, 100)).toBe(true);

    expect(node.fx).toBe(node.x);
    expect(node.fy).toBe(node.y);
    sim.stop();
  });

  it("reheats the walk for a real drag, so checklist §7.3's neighbours resettle", () => {
    const { sim, node, press } = pressed();

    pressMoved(press, sim, node, 140, 100);

    expect(sim.heldAlpha).toBeGreaterThan(0);
    sim.stop();
  });

  it("leaves a dragged node where it was dropped and lets the walk cool (checklist §7.3)", () => {
    const { sim, node, press } = pressed();

    pressMoved(press, sim, node, 140, 100);
    sim.dragTo(node, 12, 34);
    const clicked = pressEnded(press, sim, 140, 100);

    expect(node.fx).toBe(12);
    expect(node.fy).toBe(34);
    expect(sim.heldAlpha).toBe(0);
    expect(clicked).toBeNull();
    sim.stop();
  });

  it("runs no click-PPR for a drag released back over its origin (checklist §7.6)", () => {
    // Distance from the release point cannot tell this from a click: the
    // gesture travelled far enough to pin the node and then came back. Whether
    // the drag began is what decides.
    const { sim, node, press } = pressed();

    pressMoved(press, sim, node, 140, 100);
    const clicked = pressEnded(press, sim, 100, 100);

    expect(clicked).toBeNull();
    expect(node.fx).toBe(node.x);
    sim.stop();
  });

  it("calls no release a click when the travel arrived with it", () => {
    // No `pointermove` reported the distance, so nothing began — but the
    // pointer did move, and checklist §7.6's click is the one without movement.
    const { sim, node, press } = pressed();

    const clicked = pressEnded(press, sim, 140, 100);

    expect(clicked).toBeNull();
    expect(node.fx).toBeUndefined();
    expect(sim.heldAlpha).toBe(0);
    sim.stop();
  });
});

describe("§9's overlay: ring, stroke, ramp, dim", () => {
  // Peak deliberately not 1: with a peak of 1.0 the division is the identity
  // and the normalization assertion reads back its own inputs. Deleting the
  // `/ peak` used to pass this block clean.
  const scores = new Map([
    ["a.md", 4],
    ["b.md", 2],
    ["c.md", 1],
    ["cold.md", 0],
  ]);

  it("names which of §9's three overlays it is", () => {
    // The pane tells a click-PPR overlay it produced from a gesture apart from
    // one the user asked for, so opening a page does not discard the latter.
    expect(fromClickPPR(scores, "a.md", 2).source).toBe("click");
    expect(fromInspect({ mode: "B", seeds: [], ranked: [] }, 2, "q").source).toBe("inspect");
    expect(fromTrace({ seeds: [], top: [] }, "B", 0).source).toBe("trace");
  });

  it("rings the seed and strokes the top K", () => {
    const overlay = fromClickPPR(scores, "a.md", 2);

    expect([...overlay.seeds]).toEqual(["a.md"]);
    expect(overlay.topK).toEqual(new Set(["a.md", "b.md"]));
  });

  it("normalizes the ramp against the strongest node", () => {
    // PPR scores are small absolute numbers; a ramp keyed to raw values is flat
    // everywhere. The overlay answers "what did this reach", which is relative.
    const overlay = fromClickPPR(scores, "a.md", 2);

    expect(overlay.scores?.get("a.md")).toBe(1);
    expect(overlay.scores?.get("b.md")).toBe(0.5);
    expect(overlay.scores?.get("c.md")).toBe(0.25);
  });

  it("survives an isolated seed, whose every score is zero", () => {
    // §7.2 gives a degree-0 seed the teleport mass and everything else zero, so
    // the peak is zero and no ratio is defined. The ramp comes back empty —
    // never NaN, which would paint as a colour nobody chose.
    const overlay = fromClickPPR(new Map([["lonely.md", 0]]), "lonely.md", 5);

    expect(overlay.scores?.size).toBe(0);
    for (const value of overlay.scores?.values() ?? []) expect(Number.isNaN(value)).toBe(false);
    // It is still the seed, so it is still lit and still ringed.
    expect(isLit(overlay, "lonely.md")).toBe(true);
  });

  it("ignores a negative score a hand-edited trace could carry", () => {
    // `parseTop` accepts `-0.5`, so this reaches `normalize` from a note the
    // user has edited. It must not produce a negative ramp position, which
    // would mix the heat colour backwards past the kind colour.
    const overlay = fromTrace({ seeds: [], top: [{ path: "odd.md", score: -0.5 }] }, "B", 0);

    expect(overlay.scores?.size).toBe(0);
    expect(heatOf(overlay, "odd.md")).toBe(0);
  });

  it("dims a node the walk never reached", () => {
    // §9: "non-neighborhood dimmed".
    const overlay = fromClickPPR(scores, "a.md", 2);

    expect(isLit(overlay, "c.md")).toBe(true);
    expect(isLit(overlay, "cold.md")).toBe(false);
    expect(isLit(overlay, "absent.md")).toBe(false);
  });

  it("breaks top-K ties by path, so two runs agree", () => {
    // §7.2's rule for ranking, applied to the same data the ranking produced.
    const tied = new Map([
      ["z.md", 0.4],
      ["a.md", 0.4],
      ["m.md", 0.4],
    ]);

    expect([...fromClickPPR(tied, "a.md", 2).topK].sort()).toEqual(["a.md", "m.md"]);
  });

  it("carries no ramp for a Mode-A inspection, and one for Mode B", () => {
    // §9: Mode A overlays "seeds and lexical top-K without a PPR heat ramp".
    // Null rather than an empty map — an empty map paints every node at zero
    // heat, which is a ramp, just a flat one.
    const ranked = [
      { path: "a.md", score: 4 },
      { path: "b.md", score: 2 },
    ];

    expect(fromInspect({ mode: "A", seeds: ["a.md"], ranked }, 2, "q").scores).toBeNull();
    expect(fromInspect({ mode: "B", seeds: ["a.md"], ranked }, 2, "q").scores).not.toBeNull();
  });

  it("lights a Mode-A overlay by seeds and top-K alone", () => {
    const overlay = fromInspect(
      { mode: "A", seeds: ["seed.md"], ranked: [{ path: "top.md", score: 3 }] },
      5,
      "q",
    );

    expect(isLit(overlay, "seed.md")).toBe(true);
    expect(isLit(overlay, "top.md")).toBe(true);
    expect(isLit(overlay, "other.md")).toBe(false);
  });

  it("replays a trace from its recorded scores, and counts what it could not find", () => {
    const overlay = fromTrace(
      { seeds: ["s.md"], top: [{ path: "t.md", score: 0.08 }] },
      "B",
      2,
    );

    expect(overlay.scores?.get("t.md")).toBe(1);
    expect(overlay.label).toContain("2 unresolved");
    expect(fromTrace({ seeds: [], top: [] }, "B", 0).label).not.toContain("unresolved");
  });
});

describe("§9's filter, and how it composes with the overlay", () => {
  it("matches on title or path, case-insensitively", () => {
    const target = node("wiki/concepts/PageRank.md", { title: "PageRank" });

    expect(matchesFilter(target, "pagerank")).toBe(true);
    expect(matchesFilter(target, "CONCEPTS")).toBe(true);
    expect(matchesFilter(target, "photosynthesis")).toBe(false);
  });

  it("matches everything when empty or blank", () => {
    const target = node("a.md");

    expect(matchesFilter(target, "")).toBe(true);
    expect(matchesFilter(target, "   ")).toBe(true);
  });

  it("dims for the overlay and the filter independently", () => {
    // §9 describes them as separate controls. A node outside both is dimmer
    // than one outside either, so both remain readable at once.
    const overlay = fromClickPPR(new Map([["lit.md", 1]]), "lit.md", 1);
    const lit = node("lit.md", { title: "lit" });
    const dark = node("dark.md", { title: "dark" });

    const both = frameOf([lit, dark], { overlay, filter: "lit" });

    const litOpacity = opacityOf(lit, both);
    const oneMiss = opacityOf(dark, frameOf([dark], { overlay, filter: "" }));
    const twoMiss = opacityOf(dark, both);

    expect(litOpacity).toBe(1);
    expect(oneMiss).toBeLessThan(litOpacity);
    expect(twoMiss).toBeLessThan(oneMiss);
  });

  it("dims a filter non-match with no overlay at all", () => {
    const target = node("a.md", { title: "alpha" });

    expect(opacityOf(target, frameOf([target], { filter: "zzz" }))).toBeLessThan(1);
    expect(opacityOf(target, frameOf([target], { filter: "alp" }))).toBe(1);
  });
});

describe("§9's labels follow the current metric", () => {
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

  // Degree and score deliberately run opposite ways: n00 has the least degree
  // and the most heat. Ranking by degree and ranking by score therefore pick
  // disjoint sets, so an implementation that ignores the overlay cannot pass
  // by coincidence.
  const nodes = Array.from({ length: 20 }, (_unused, at) =>
    node(`n${String(at).padStart(2, "0")}.md`, { degree: at, x: at, y: 0 }),
  );
  // Fifteen lit, not ten. With exactly ten lit, slicing the top ten returns all
  // of them whatever the metric says — the assertion passes with the metric
  // reverted to degree, which is the defect it is meant to catch. Fifteen makes
  // the ordering decide: by score the top ten are n00–n09, by degree n05–n14.
  const hot = new Map(nodes.slice(0, 15).map((n, at) => [n.path, 15 - at]));

  it("labels the highest-degree nodes with no overlay", () => {
    const ctx = recorder();

    draw(ctx, frameOf(nodes));

    expect(new Set(ctx.texts)).toEqual(new Set(nodes.slice(10).map((n) => n.path)));
  });

  it("labels the hottest nodes when a PPR overlay supplies scores", () => {
    // §9: "labels on hover plus top-10 by current metric". Under an overlay the
    // metric is the score — labelling the degree hubs would name the pages every
    // query shares, at the one moment the names are supposed to be informative.
    const ctx = recorder();

    draw(ctx, frameOf(nodes, { overlay: fromClickPPR(hot, "n00.md", 5) }));

    expect(new Set(ctx.texts)).toEqual(new Set(nodes.slice(0, 10).map((n) => n.path)));
  });

  it("labels only lit nodes under a score-less Mode-A overlay", () => {
    // No scores to rank by, so degree still orders — but the overlay still says
    // which nodes are in play, and a dimmed node should not carry a label.
    const ctx = recorder();
    const overlay = fromInspect(
      { mode: "A", seeds: ["n00.md"], ranked: [{ path: "n01.md", score: 3 }] },
      5,
      "q",
    );

    draw(ctx, frameOf(nodes, { overlay }));

    expect(new Set(ctx.texts)).toEqual(new Set(["n00.md", "n01.md"]));
  });
});

describe("the label-drop threshold is pinned from both sides", () => {
  // §9's figure is 500. Tests using only 50 and 500 nodes leave every threshold
  // in between green, so a build that dropped labels at 60 would ship.
  const many = (count: number) =>
    Array.from({ length: count }, (_unused, at) =>
      node(`n${String(at).padStart(4, "0")}.md`, { degree: at, x: at, y: 0 }),
    );

  function labelCount(count: number): number {
    const texts: string[] = [];
    const ctx = {
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
    } as unknown as CanvasRenderingContext2D;
    draw(ctx, frameOf(many(count)));
    return texts.length;
  }

  const SPEC_DROP_AT = 500;

  it("still labels at one node below the threshold", () => {
    expect(labelCount(SPEC_DROP_AT - 1)).toBe(10);
  });

  it("drops at the threshold exactly", () => {
    expect(labelCount(SPEC_DROP_AT)).toBe(0);
  });
});
