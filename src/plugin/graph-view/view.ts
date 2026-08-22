// §9's graph pane: an `ItemView` over the §7.1 snapshot.
//
// Read-only by construction. It holds a `Core` and no `FsAdapter`, so the only
// vault access it has is what §5's façade offers — and none of what §9 asks for
// here writes anything. It is "never blocked by the lock" for the same reason:
// every entry point it uses (`getGraph`, `computePPR`, `inspect`) is lock-free.
//
// Invariant 1 has no watchers and no timers. The pane refreshes on exactly two
// things: the graph-rebuilt event, and its own refresh button. It does not
// listen to the vault. The one loop it runs is §9's own sanction — d3's
// simulation, from a reheat until it cools past `alphaMin` — and every frame is
// scheduled by an event, never by a standing `requestAnimationFrame` chain.
import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type { Core, GraphSnapshot } from "../../core/index";
import { draw, sampleTheme, type Camera, type Frame } from "./render";
import { createSim, type Sim } from "./sim";

export const GRAPH_VIEW_TYPE = "luka-graph";

/** §9: "empty vault → pointer at Compile." */
const EMPTY_VAULT_MESSAGE = "No graph yet. Run Luka: Compile to build one.";

export class LukaGraphView extends ItemView {
  private readonly core: Core;
  /** `onGraphRebuilt`'s unsubscribe, held so `onClose` can stop listening. */
  private unsubscribe: (() => void) | null = null;
  private graph: GraphSnapshot | null = null;
  private sim: Sim | null = null;
  /** The one pending frame, if any. At most one is ever outstanding. */
  private frame: number | null = null;
  private resize: ResizeObserver | null = null;

  private statusEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private canvas: HTMLCanvasElement | null = null;
  private camera: Camera = { x: 0, y: 0, scale: 1 };

  constructor(leaf: WorkspaceLeaf, core: Core) {
    super(leaf);
    this.core = core;
  }

  override getViewType(): string {
    return GRAPH_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "Luka graph";
  }

  override getIcon(): string {
    return "git-fork";
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("luka-graph-view");

    const toolbar = root.createDiv({ cls: "luka-graph-toolbar" });
    const refresh = toolbar.createEl("button", { text: "Refresh" });
    refresh.addEventListener("click", () => {
      void this.reload();
    });

    this.statusEl = root.createDiv({ cls: "luka-graph-status" });
    this.bodyEl = root.createDiv({ cls: "luka-graph-body" });

    // §7.1's rebuild signal. Subscribed before the first load so a compile that
    // finishes mid-load is not missed.
    this.unsubscribe = this.core.onGraphRebuilt((graph) => {
      this.graph = graph;
      this.render();
    });

    // A theme switch changes no data, so it schedules a repaint and nothing
    // else — that is what §15's dark/light criterion needs.
    this.registerEvent(this.app.workspace.on("css-change", () => this.schedule()));

    await this.reload();
  }

  override async onClose(): Promise<void> {
    // Invariant 1: nothing of this view outlives it. The simulation is stopped
    // and detached from its tick handler, the pending frame is cancelled, and
    // the rebuild subscription is dropped.
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sim?.stop();
    this.sim = null;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.resize?.disconnect();
    this.resize = null;
    this.canvas = null;
    this.graph = null;
    this.contentEl.empty();
  }

  /**
   * Re-reads the snapshot and redraws.
   *
   * A rejection is reported and leaves the pane in its empty state rather than
   * throwing into Obsidian's event loop: `getGraph` walks the vault, and one
   * unreadable file under `wiki/` is enough to reject it. That is a known
   * compile-side gap logged against its own milestone; what the pane owes is
   * to say so instead of rendering a blank surface with no explanation.
   */
  private async reload(): Promise<void> {
    try {
      this.graph = await this.core.getGraph();
    } catch (error) {
      this.graph = null;
      new Notice(`Luka: could not read the graph — ${message(error)}`, 6000);
    }
    this.render();
  }

  /** Rebuilds the surface for the current snapshot. */
  private render(): void {
    const graph = this.graph;

    if (graph === null || graph.nodes.length === 0) {
      this.sim?.stop();
      this.sim = null;
      this.canvas = null;
      this.resize?.disconnect();
      this.resize = null;
      this.statusEl.setText("");
      this.bodyEl.empty();
      this.bodyEl.createDiv({ cls: "luka-graph-empty", text: EMPTY_VAULT_MESSAGE });
      return;
    }

    this.statusEl.setText(
      `${String(graph.nodes.length)} nodes, ${String(graph.edges.length)} edges`,
    );

    if (this.canvas === null) {
      this.bodyEl.empty();
      this.canvas = this.bodyEl.createEl("canvas", { cls: "luka-graph-canvas" });
      this.resize = new ResizeObserver(() => this.schedule());
      this.resize.observe(this.bodyEl);
      // Centre the origin: `sim.ts` seeds positions on a disc around (0, 0).
      this.camera = { x: this.bodyEl.clientWidth / 2, y: this.bodyEl.clientHeight / 2, scale: 1 };
    }

    // §9's refresh keeps surviving nodes where they are and hash-seeds the new
    // ones, so a compile does not throw away the layout the user is reading.
    if (this.sim === null) this.sim = createSim(graph, () => this.schedule());
    else this.sim.replace(graph);

    this.schedule();
  }

  /**
   * Requests one frame.
   *
   * Every draw goes through here, and a frame already pending swallows the
   * request — so a tick storm, a resize and a theme change together still cost
   * one paint. When the simulation cools, ticks stop arriving and nothing
   * schedules anything: the pane goes quiet until the next gesture.
   */
  private schedule(): void {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.paint();
    });
  }

  private paint(): void {
    const canvas = this.canvas;
    const sim = this.sim;
    const graph = this.graph;
    if (canvas === null || sim === null || graph === null) return;

    const width = this.bodyEl.clientWidth;
    const height = this.bodyEl.clientHeight;
    if (width === 0 || height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${String(width)}px`;
      canvas.style.height = `${String(height)}px`;
    }

    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    const frame: Frame = {
      nodes: sim.nodes,
      edges: graph.edges,
      camera: this.camera,
      theme: sampleTheme(this.contentEl),
      dpr,
      width,
      height,
      hovered: null,
    };
    draw(ctx, frame);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
