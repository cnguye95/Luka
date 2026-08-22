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
import {
  normalizeSettings,
  parseTrace,
  resolveTraceNodes,
  type Core,
  type GraphSnapshot,
  type LukaSettings,
} from "../../core/index";
import { fromClickPPR, fromTrace, type Overlay } from "./overlay";
import { draw, hitTest, sampleTheme, toGraph, type Camera, type Frame } from "./render";
import { createSim, type Sim, type SimNode } from "./sim";

export const GRAPH_VIEW_TYPE = "luka-graph";

/** §9: "empty vault → pointer at Compile." */
const EMPTY_VAULT_MESSAGE = "No graph yet. Run Luka: Compile to build one.";

/**
 * Interaction constants. §9 and §17 fix none of these, so §0 takes the smallest
 * option: module-local, not settings fields.
 */
const ZOOM_SENSITIVITY = 0.002;
const MIN_SCALE = 0.15;
const MAX_SCALE = 6;
const TOOLTIP_OFFSET = 12;
/** Pointer travel, in CSS pixels, that turns a click into a drag. */
const CLICK_SLOP = 4;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/**
 * What the pane needs from the plugin, as two functions rather than the plugin
 * itself — `main.ts` imports this module, so importing it back would be a cycle.
 */
export interface GraphHost {
  /** §9 gates the replay button on "an answer note is active". */
  activeAnswerPath(): string | null;
  readNote(path: string): Promise<string>;
}

export class LukaGraphView extends ItemView {
  private readonly core: Core;
  private readonly settings: LukaSettings;
  private readonly host: GraphHost;
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
  private tooltipEl: HTMLElement | null = null;
  private camera: Camera = { x: 0, y: 0, scale: 1 };
  private hovered: string | null = null;
  private overlay: Overlay | null = null;
  private filter = "";
  /** Where a pointer went down, so a drag is not mistaken for a click. */
  private pressedAt: { x: number; y: number } | null = null;
  /** The node under an active drag, or `null` when panning or idle. */
  private dragging: SimNode | null = null;
  /** Where a background pan started, in canvas space. */
  private panFrom: { x: number; y: number; camX: number; camY: number } | null = null;

  private replayEl: HTMLButtonElement | null = null;

  constructor(leaf: WorkspaceLeaf, core: Core, settings: LukaSettings, host: GraphHost) {
    super(leaf);
    this.core = core;
    // The plugin's live object, not a copy: §17's numbers are read when they
    // are used, so a change in the settings tab reaches the next overlay.
    this.settings = settings;
    this.host = host;
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

    // §9: "lexical filter box dims non-matches (no model call)". Nothing here
    // touches the provider, and the handler is a plain substring test.
    const filter = toolbar.createEl("input", {
      type: "search",
      cls: "luka-graph-filter",
      placeholder: "Filter…",
    });
    this.registerDomEvent(filter, "input", () => {
      this.filter = filter.value;
      this.schedule();
    });

    // §9: "'Show retrieval on graph' (command + button when an answer note is
    // active)". The command lives in `commands.ts`; this is the button half.
    this.replayEl = toolbar.createEl("button", { text: "Show retrieval" });
    this.registerDomEvent(this.replayEl, "click", () => {
      const path = this.host.activeAnswerPath();
      if (path !== null) void this.showRetrieval(path);
    });
    // A workspace event, not a vault one: it changes which button is visible
    // and runs no operation, so invariant 1's "no watchers" is untouched.
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncReplayButton()));
    this.syncReplayButton();

    // §9: "Esc clears overlay". On the container rather than the canvas so it
    // works wherever focus sits inside the pane.
    this.registerDomEvent(root, "keydown", (event: KeyboardEvent) => {
      if (event.key !== "Escape" || this.overlay === null) return;
      event.preventDefault();
      this.setOverlay(null);
    });
    // Focusable, or the container never receives the key at all.
    root.tabIndex = -1;

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
    this.tooltipEl = null;
    this.dragging = null;
    this.panFrom = null;
    this.hovered = null;
    this.overlay = null;
    this.filter = "";
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

    this.statusEl.setText(this.statusText());

    if (this.canvas === null) {
      this.bodyEl.empty();
      this.canvas = this.bodyEl.createEl("canvas", { cls: "luka-graph-canvas" });
      this.tooltipEl = this.bodyEl.createDiv({ cls: "luka-graph-tooltip" });
      this.tooltipEl.hide();
      this.resize = new ResizeObserver(() => this.schedule());
      this.resize.observe(this.bodyEl);
      // Centre the origin: `sim.ts` seeds positions on a disc around (0, 0).
      this.camera = { x: this.bodyEl.clientWidth / 2, y: this.bodyEl.clientHeight / 2, scale: 1 };
      this.attachPointer(this.canvas);
    }

    // §9's refresh keeps surviving nodes where they are and hash-seeds the new
    // ones, so a compile does not throw away the layout the user is reading.
    if (this.sim === null) this.sim = createSim(graph, () => this.schedule());
    else this.sim.replace(graph);

    this.schedule();
  }

  /**
   * §9's interactions: pan/zoom, hover, drag-to-pin, double-click.
   *
   * All of them resolve a pointer through `render.ts`'s camera transform —
   * `hitTest` for what is under the cursor, `toGraph` for where a drag is
   * putting a node — rather than a second copy of the arithmetic here, so the
   * pane cannot disagree with the picture it drew.
   *
   * Registered through `registerDomEvent`, so Obsidian detaches them with the
   * view: invariant 1 leaves nothing listening after `onClose`.
   */
  private attachPointer(canvas: HTMLCanvasElement): void {
    const at = (event: PointerEvent | MouseEvent | WheelEvent) => {
      const box = canvas.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };

    this.registerDomEvent(canvas, "pointerdown", (event: PointerEvent) => {
      const frame = this.currentFrame();
      if (frame === null) return;
      const point = at(event);
      const node = hitTest(frame, point.x, point.y);
      canvas.setPointerCapture(event.pointerId);
      if (node === null) {
        this.panFrom = { x: point.x, y: point.y, camX: this.camera.x, camY: this.camera.y };
        return;
      }
      this.dragging = node;
      this.pressedAt = point;
      this.sim?.dragStart(node);
    });

    this.registerDomEvent(canvas, "pointermove", (event: PointerEvent) => {
      const frame = this.currentFrame();
      if (frame === null) return;
      const point = at(event);

      if (this.dragging !== null) {
        const graphPoint = toGraph(this.camera, point.x, point.y);
        this.sim?.dragTo(this.dragging, graphPoint.x, graphPoint.y);
        this.schedule();
        return;
      }

      if (this.panFrom !== null) {
        this.camera = {
          ...this.camera,
          x: this.panFrom.camX + (point.x - this.panFrom.x),
          y: this.panFrom.camY + (point.y - this.panFrom.y),
        };
        this.schedule();
        return;
      }

      const node = hitTest(frame, point.x, point.y);
      const path = node?.path ?? null;
      if (path !== this.hovered) {
        this.hovered = path;
        this.schedule();
      }
      this.showTooltip(node, point.x, point.y);
    });

    const endGesture = (event: PointerEvent) => {
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      const node = this.dragging;
      const from = this.pressedAt;
      // §9's drag *pins*: `dragEnd` lets the walk cool but leaves `fx`/`fy` set,
      // so the node stays where it was dropped.
      if (node !== null) this.sim?.dragEnd();
      this.dragging = null;
      this.panFrom = null;
      this.pressedAt = null;

      // A press that did not travel is a click, not a drag. §9 gives the two
      // gestures different jobs on the same button, and distance is what tells
      // them apart — a pin that also re-ran PPR would fire on every drag.
      if (node === null || from === null) return;
      const point = at(event);
      if (Math.hypot(point.x - from.x, point.y - from.y) > CLICK_SLOP) return;
      void this.runClickPPR(node.path);
    };
    this.registerDomEvent(canvas, "pointerup", endGesture);
    this.registerDomEvent(canvas, "pointercancel", endGesture);

    this.registerDomEvent(canvas, "pointerleave", () => {
      this.hovered = null;
      this.hideTooltip();
      this.schedule();
    });

    this.registerDomEvent(canvas, "wheel", (event: WheelEvent) => {
      // Zoom about the cursor: the graph point under the pointer has to stay
      // under it, which is why this needs the inverse transform and not just a
      // scale factor.
      event.preventDefault();
      const point = at(event);
      const before = toGraph(this.camera, point.x, point.y);
      const factor = Math.exp(-event.deltaY * ZOOM_SENSITIVITY);
      const scale = clamp(this.camera.scale * factor, MIN_SCALE, MAX_SCALE);
      this.camera = {
        scale,
        x: point.x - before.x * scale,
        y: point.y - before.y * scale,
      };
      this.schedule();
    });

    this.registerDomEvent(canvas, "dblclick", (event: MouseEvent) => {
      const frame = this.currentFrame();
      if (frame === null) return;
      const point = at(event);
      const node = hitTest(frame, point.x, point.y);
      if (node === null) return;
      // The active leaf: §8.3 asks for a new one, and only for answer notes.
      void this.app.workspace.openLinkText(node.path, "", false);
    });
  }

  /** §9 shows the replay button only while an answer note is active. */
  private syncReplayButton(): void {
    const button = this.replayEl;
    if (button === null) return;
    if (this.host.activeAnswerPath() === null) button.hide();
    else button.show();
  }

  /**
   * §9's trace replay: "parses the trace and overlays, zero calls, graceful
   * notice if the note has no trace".
   *
   * Recorded data only. The graph on screen may not be the graph the answer was
   * written against, so re-ranking would show what retrieval *would* reach now
   * — a different claim from the one the note is making.
   */
  async showRetrieval(answerPath: string): Promise<void> {
    let trace;
    try {
      trace = parseTrace(await this.host.readNote(answerPath)).trace;
    } catch (error) {
      new Notice(`Luka: could not read ${answerPath} — ${message(error)}`, 6000);
      return;
    }
    if (trace === null) {
      // §9 asks for this to be graceful: a note whose block the user deleted,
      // or an answer from before the trace existed, is not an error.
      new Notice("Luka: that note has no retrieval trace to show.", 6000);
      return;
    }

    const graph = this.graph ?? (await this.core.getGraph().catch(() => null));
    if (graph === null) {
      new Notice("Luka: no graph to show the trace on. Run Luka: Compile.", 6000);
      return;
    }

    const resolved = resolveTraceNodes(trace, graph);
    this.setOverlay(fromTrace(resolved, trace.mode, resolved.unresolved.length));
  }

  /**
   * §9: "click a node → instant PPR from that node (no model call)".
   *
   * `computePPR` takes no lock, so this works while a compile runs — and makes
   * no provider call, which is why §9 calls it instant.
   */
  private async runClickPPR(path: string): Promise<void> {
    try {
      const result = await this.core.computePPR([path]);
      // Never `snapshots: true`: the per-iteration vectors are the M5
      // scrubber's, and retaining up to 100 of them costs memory for a feature
      // this milestone does not ship.
      this.setOverlay(fromClickPPR(result.scores, path, this.topK()));
    } catch (error) {
      new Notice(`Luka: could not rank from that node — ${message(error)}`, 6000);
    }
  }

  /** §9's top-K stroke uses §17's existing K; M4 adds no tunable. */
  private topK(): number {
    return normalizeSettings(this.settings).assemblyCap;
  }

  private setOverlay(overlay: Overlay | null): void {
    this.overlay = overlay;
    this.statusEl.setText(this.statusText());
    this.schedule();
  }

  private statusText(): string {
    const graph = this.graph;
    if (graph === null) return "";
    const counts = `${String(graph.nodes.length)} nodes, ${String(graph.edges.length)} edges`;
    return this.overlay === null ? counts : `${counts} — ${this.overlay.label}`;
  }

  /** §9's hover tooltip: "title, kind, summary" — from the node, never the vault. */
  private showTooltip(node: SimNode | null, x: number, y: number): void {
    const tooltip = this.tooltipEl;
    if (tooltip === null) return;
    if (node === null) {
      this.hideTooltip();
      return;
    }
    tooltip.empty();
    tooltip.createDiv({ cls: "luka-graph-tooltip-title", text: node.title });
    tooltip.createDiv({ cls: "luka-graph-tooltip-kind", text: node.kind });
    // A raw source has no frontmatter, so it has no summary; the row is left
    // out rather than rendered blank.
    if (node.summary !== "") {
      tooltip.createDiv({ cls: "luka-graph-tooltip-summary", text: node.summary });
    }
    tooltip.style.left = `${String(x + TOOLTIP_OFFSET)}px`;
    tooltip.style.top = `${String(y + TOOLTIP_OFFSET)}px`;
    tooltip.show();
  }

  private hideTooltip(): void {
    this.tooltipEl?.hide();
  }

  /** The frame as it currently stands, or `null` when there is nothing drawn. */
  private currentFrame(): Frame | null {
    const sim = this.sim;
    const graph = this.graph;
    if (sim === null || graph === null) return null;
    return {
      nodes: sim.nodes,
      edges: graph.edges,
      camera: this.camera,
      theme: sampleTheme(this.contentEl),
      dpr: window.devicePixelRatio || 1,
      width: this.bodyEl.clientWidth,
      height: this.bodyEl.clientHeight,
      hovered: this.hovered,
      overlay: this.overlay,
      filter: this.filter,
    };
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

    // One frame description, shared with every hit test, so what is drawn and
    // what a pointer resolves against can never be two different things.
    const frame = this.currentFrame();
    if (frame !== null) draw(ctx, frame);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
