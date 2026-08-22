// §9's layout: `d3-force` only, "initial positions seeded by hashing page
// path", "simulation cools to a stop, drag reheats locally".
//
// No DOM and no Obsidian import: this owns positions and nothing else, so the
// view can be read for lifecycle and this can be read for physics.
//
// Invariant 1 forbids timers and background work. d3's simulation is the one
// thing §9 sanctions, and the sanction is narrow: it runs from a reheat until
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
 * Layout constants. §17 names none of these and §9 fixes none of them, so §0
 * takes the smallest option: module-local, not settings fields.
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
  /** Positions for a fresh snapshot, keeping what survived (§9's refresh). */
  replace(graph: GraphSnapshot): void;
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
 * §9 wants positions "seeded by hashing page path" so a pane reopened on the
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

  const simulation: Simulation<SimNode, SimLink> = forceSimulation<SimNode>([])
    .force("charge", forceManyBody<SimNode>().strength(CHARGE_STRENGTH))
    .force("center", forceCenter<SimNode>(0, 0).strength(CENTER_STRENGTH))
    .force("collide", forceCollide<SimNode>(COLLIDE_RADIUS))
    .alphaMin(ALPHA_MIN)
    .on("tick", onTick);

  function replace(next: GraphSnapshot): void {
    const survivors = new Map(byPath);
    byPath.clear();

    nodes = next.nodes.map((node) => {
      // §9's refresh keeps what is still there where the user last saw it —
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
      // §7.1 guarantees both ends are nodes; a snapshot that says otherwise is
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
    simulation.alpha(REHEAT_ALPHA).restart();
  }

  replace(graph);

  return {
    get nodes() {
      return nodes;
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
      // Back to zero so the walk cools to a stop again (§9). `fx`/`fy` stay
      // set: §9's drag *pins*, so the node keeps where it was dropped.
      simulation.alphaTarget(0);
    },
  };
}
