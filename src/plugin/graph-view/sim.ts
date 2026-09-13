// The layout: `d3-force` only, "initial positions seeded by hashing page
// path", "simulation cools to a stop, drag reheats locally".
//
// No DOM and no Obsidian import: this owns positions and nothing else, so the
// view can be read for lifecycle and this can be read for physics.
//
// Invariant 1 forbids timers and background work. d3's simulation is the one
// thing sanctioned, and the sanction is narrow: it runs from a reheat until
// alpha decays past `alphaMin`, then `d3` stops its own internal timer and the
// view stops scheduling frames. Nothing restarts it but a user gesture.
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { GraphSnapshot } from "../../core/index";

/**
 * Layout constants. Nothing fixes these, so the
 * smallest option applies: module-local, not settings fields.
 */
const LINK_DISTANCE = 60;
const CHARGE_STRENGTH = -160;
const CENTER_STRENGTH = 0.05;
/** Radius a node reserves so labels have room; `render.ts` draws smaller. */
const COLLIDE_RADIUS = 14;
/** d3's own default. Reaching it is what "cools to a stop" means. */
const ALPHA_MIN = 0.001;
/** Where a drag holds alpha while the pointer is down. */
const DRAG_ALPHA_TARGET = 0.3;
/** How hard a refresh or drag-release restarts the walk. */
const REHEAT_ALPHA = 0.3;
/** Radius of the disc initial positions are hashed onto. */
const SEED_RADIUS = 320;

export interface SimNode extends SimulationNodeDatum {
  path: string;
  title: string;
  kind: string;
  degree: number;
  summary: string;
}

type SimLink = SimulationLinkDatum<SimNode>;

export interface Sim {
  readonly nodes: SimNode[];
  /**
   * The alpha the walk is being *held* at — d3's `alphaTarget`. Zero unless a
   * drag is holding it warm, which is what "cools to a stop" needs; readable so
   * the reheat can be asserted without running d3's timer.
   */
  readonly heldAlpha: number;
  /**
   * How hot the walk is — d3's `alpha`.
   *
   * A plain field read, and the reheat's own witness: `alpha(x)` assigns
   * synchronously and `restart()` only schedules d3's timer, which fires on a
   * later turn, so a test that reads this straight after `replace` sees
   * exactly what `replace` left. `heldAlpha` cannot serve — `alphaTarget` is
   * what a drag holds and a reheat never touches it.
   */
  readonly alpha: number;
  /**
   * One synchronous step of the walk — d3's own static-layout API.
   *
   * Here so a test can cool the layout off its starting alpha without waiting
   * on the timer; nothing in the view calls it, because the view lets d3 tick
   * on its own.
   */
  tick(): void;
  /**
   * Positions for a fresh snapshot, keeping what survived (a refresh).
   *
   * Returns whether the walk was reheated. A snapshot whose nodes and edges
   * match the current ones changes no layout, so it carries the new titles,
   * kinds, degrees and summaries onto the nodes already held and leaves alpha
   * alone; everything else reheats as before. The boolean says what it did;
   * `alpha` shows it, which is the assertion that would have caught a reheat
   * smuggled in beside a `false`.
   */
  replace(graph: GraphSnapshot): boolean;
  stop(): void;
  /** Holds a node under the pointer and keeps the walk warm while it moves. */
  dragStart(node: SimNode): void;
  dragTo(node: SimNode, x: number, y: number): void;
  /** Releases the drag but leaves the node pinned where it was dropped. */
  dragEnd(): void;
  /** The node at this path in the current set, or `undefined` if it is gone. */
  nodeAt(path: string): SimNode | undefined;
}

/**
 * FNV-1a, 32-bit.
 *
 * Positions are "seeded by hashing page path" so a pane reopened on the
 * same vault starts from the same shape. `core/hash.ts` is SHA-256 and async;
 * a layout seed needs neither cryptographic strength nor a promise, and pulling
 * an async hash into a synchronous layout would make the first frame wait on
 * the vault for no benefit.
 */
function hash32(text: string): number {
  let value = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    value ^= text.charCodeAt(at);
    // The FNV prime, as shifts, so the multiply stays inside 32 bits.
    value += (value << 1) + (value << 4) + (value << 7) + (value << 8) + (value << 24);
    value >>>= 0;
  }
  return value >>> 0;
}

/**
 * Whether two snapshots carry the same nodes and the same edges.
 *
 * Compared in order rather than as sets: `buildGraph` sorts both by
 * `comparePaths` before returning, so two snapshots of one vault agree
 * position by position, and a snapshot that does not is not one this pane was
 * given. Paths and edge pairs only — a page whose summary was rewritten is the
 * same topology, and moving the layout for it is the reheat this guards.
 */
export function sameTopology(a: GraphSnapshot, b: GraphSnapshot): boolean {
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
  for (let at = 0; at < a.nodes.length; at++) {
    if (a.nodes[at]?.path !== b.nodes[at]?.path) return false;
  }
  for (let at = 0; at < a.edges.length; at++) {
    const one = a.edges[at];
    const other = b.edges[at];
    if (one?.a !== other?.a || one?.b !== other?.b) return false;
  }
  return true;
}

/** A deterministic point on a disc, from two independent slices of the hash. */
function seedPosition(path: string): { x: number; y: number } {
  const h = hash32(path);
  const angle = ((h & 0xffff) / 0x10000) * Math.PI * 2;
  // The high bits drive the radius; the square root spreads points evenly over
  // the disc rather than crowding them at the centre.
  const radius = Math.sqrt((h >>> 16) / 0x10000) * SEED_RADIUS;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

export function createSim(graph: GraphSnapshot, onTick: () => void): Sim {
  let nodes: SimNode[] = [];
  const byPath = new Map<string, SimNode>();
  /** The snapshot the current layout was built for, to compare the next against. */
  let current: GraphSnapshot | null = null;

  const simulation: Simulation<SimNode, SimLink> = forceSimulation<SimNode>([])
    .force("charge", forceManyBody<SimNode>().strength(CHARGE_STRENGTH))
    .force("center", forceCenter<SimNode>(0, 0).strength(CENTER_STRENGTH))
    .force("collide", forceCollide<SimNode>(COLLIDE_RADIUS))
    .alphaMin(ALPHA_MIN)
    .on("tick", onTick);

  function replace(next: GraphSnapshot): boolean {
    if (current !== null && sameTopology(current, next)) {
      // A compile that changed nothing, or changed only prose. There is no new
      // layout to find, and reheating would drift a settled one the user has
      // been reading — the finding this guard closes. What can still have
      // moved is a page's own metadata, which the tooltip reads, so it is
      // carried onto the nodes already held. Degree cannot differ: `buildGraph`
      // derives it from the edges just compared.
      for (const node of next.nodes) {
        const held = byPath.get(node.path);
        if (held === undefined) continue;
        held.title = node.title;
        held.kind = node.kind;
        held.degree = node.degree;
        held.summary = node.summary;
      }
      current = next;
      return false;
    }

    const survivors = new Map(byPath);
    byPath.clear();

    nodes = next.nodes.map((node) => {
      // A refresh keeps what is still there where the user last saw it —
      // re-hashing every position on each compile would throw the layout the
      // user has been reading, and any pinning they did with it.
      const existing = survivors.get(node.path);
      const seeded = existing ?? seedPosition(node.path);
      const sim: SimNode = {
        path: node.path,
        title: node.title,
        kind: node.kind,
        degree: node.degree,
        summary: node.summary,
        x: seeded.x,
        y: seeded.y,
        ...(existing?.fx === undefined ? {} : { fx: existing.fx }),
        ...(existing?.fy === undefined ? {} : { fy: existing.fy }),
      };
      byPath.set(node.path, sim);
      return sim;
    });

    const links: SimLink[] = [];
    for (const edge of next.edges) {
      const a = byPath.get(edge.a);
      const b = byPath.get(edge.b);
      // The graph guarantees both ends are nodes; a snapshot saying otherwise is
      // one d3 would throw on, so the link is dropped instead.
      if (a !== undefined && b !== undefined) links.push({ source: a, target: b });
    }

    simulation.nodes(nodes);
    simulation.force(
      "link",
      forceLink<SimNode, SimLink>(links)
        .id((node) => node.path)
        .distance(LINK_DISTANCE),
    );
    current = next;
    simulation.alpha(REHEAT_ALPHA).restart();
    return true;
  }

  replace(graph);

  return {
    get nodes() {
      return nodes;
    },
    get heldAlpha() {
      return simulation.alphaTarget();
    },
    get alpha() {
      return simulation.alpha();
    },
    tick: () => {
      simulation.tick();
    },
    replace,
    nodeAt: (path: string) => byPath.get(path),
    stop: () => {
      simulation.on("tick", null);
      simulation.stop();
    },
    dragStart: (node) => {
      simulation.alphaTarget(DRAG_ALPHA_TARGET).restart();
      node.fx = node.x;
      node.fy = node.y;
    },
    dragTo: (node, x, y) => {
      node.fx = x;
      node.fy = y;
    },
    dragEnd: () => {
      // Back to zero so the walk cools to a stop again. `fx`/`fy` stay
      // set: a drag *pins*, so the node keeps where it was dropped.
      simulation.alphaTarget(0);
    },
  };
}
