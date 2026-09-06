// §9's graph pane: an `ItemView` over the §7.1 snapshot.
//
// Read-only by construction. It holds a `Core` and no `FsAdapter`, so the only
// vault access it has is what §5's façade offers — and none of what §9 asks for
// here writes anything. It is "never blocked by the lock" for the same reason:
// every entry point it uses (`getGraph`, `computePPR`, `inspect`) is lock-free.
//
// Invariant 1 has no watchers and no timers, and this file has neither: no
// `setTimeout`, no `setInterval`, no vault listener. The pane refreshes on
// exactly two things — the graph-rebuilt event and its own refresh button. The
// one loop it runs is §9's own sanction, d3's simulation, from a reheat until
// it cools past `alphaMin`; every frame is scheduled by an event, never by a
// standing `requestAnimationFrame` chain. A deferral was tried for the
// double-click case and removed: it was both a timer the invariant forbids and
// shorter than the platform's own double-click interval, so it fired anyway.
import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import {
  modeOf,
  normalizeSettings,
  parseTrace,
  resolveTraceNodes,
  type Core,
  type GraphSnapshot,
  type LukaSettings,
} from "../../core/index";
import { fromClickPPR, fromInspect, fromTrace, type Overlay } from "./overlay";
import { scrubLabel, scrubTo, stopsOf, withScrub } from "./scrub";
import { pressEnded, pressMoved, pressOn, type Press } from "./press";
import { draw, hitTest, sampleTheme, toGraph, type Camera, type Frame } from "./render";
import { createSim, type Sim, type SimNode } from "./sim";

export const GRAPH_VIEW_TYPE = "luka-graph";

/** §9: "empty vault → pointer at Compile." */
const EMPTY_VAULT_MESSAGE = "No graph yet. Run Luka: Compile to build one.";

/** §9's wording, verbatim. The live counts follow it. */
const MODE_A_BANNER = "Mode A (lexical) active — graph ranking off";

/** §9's label, verbatim — and a claim about cost `Core.inspect` has to keep. */
const INSPECT_LABEL = "Inspect (1 model call)";

/**
 * Interaction constants. §9 and §17 fix none of these, so §0 takes the smallest
 * option: module-local, not settings fields.
 */
const ZOOM_SENSITIVITY = 0.002;
const MIN_SCALE = 0.15;
const MAX_SCALE = 6;
const TOOLTIP_OFFSET = 12;
/** Device ratio the exported PNG is rendered at, independent of the display. */
const PNG_SCALE = 2;

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
  private bannerEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  /** §9's scrubber: the row, its slider and its label. Hidden without a walk. */
  private scrubEl: HTMLElement | null = null;
  private sliderEl: HTMLInputElement | null = null;
  private scrubLabelEl: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private tooltipEl: HTMLElement | null = null;
  private camera: Camera = { x: 0, y: 0, scale: 1 };
  private hovered: string | null = null;
  private overlay: Overlay | null = null;
  private filter = "";
  /**
   * The press on a node currently in progress, or `null` when panning or idle.
   *
   * `press.ts` owns what it becomes: a press starts nothing, and the drag —
   * with its reheat and its pin — begins on the move that passes `CLICK_SLOP`.
   * Before that the gesture is still a candidate click, and §9 gives a click no
   * business moving the layout.
   */
  private press: Press | null = null;
  /** Where a background pan started, in canvas space. */
  private panFrom: { x: number; y: number; camX: number; camY: number } | null = null;

  private replayEl: HTMLButtonElement | null = null;
  private inspectEl: HTMLButtonElement | null = null;
  /**
   * Set in `onClose`. `getGraph()` can take seconds on a cold vault, and a
   * `reload` that resolves after the view is gone would find `canvas === null`
   * — the same condition a first render uses — and rebuild the simulation, the
   * ResizeObserver and the pointer listeners onto a detached element, with the
   * teardown that would have released them already run.
   */
  private closed = false;
  /**
   * The overlay standing before the current run of click-PPRs, so opening a
   * page can put it back.
   *
   * §9 gives Esc the job of clearing an overlay. A double-click's own first
   * press produces a click-PPR overlay on the way past, and discarding an
   * Inspect or replay overlay the user deliberately asked for is not something
   * "double-click opens the page" licenses.
   */
  private beforeClick: Overlay | null = null;
  /**
   * Bumped when a double-click lands. A click-PPR still in flight from that
   * gesture's first press checks it and drops its result — otherwise, on the
   * cold path where `computePPR` has to walk the vault, the overlay resolves
   * after the page opens and reappears on top of it.
   */
  private clickEpoch = 0;
  /**
   * True while an inspect call is in flight. The disabled button covers the
   * mouse; nothing covered the Enter key, which called the same handler
   * directly — so a held key billed one model call per repeat.
   */
  private inspecting = false;

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
    this.registerDomEvent(refresh, "click", () => {
      // Forced: checklist §5.5 asks this button to see a compile run in another
      // window or a vault sync, and neither fires this window's rebuild event.
      void this.reload(true);
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

    // §9's query inspection: a query box and a button whose label is a promise
    // about cost. `Core.inspect` runs §7.4 steps 1–3 and stops, which is what
    // makes the promise true — see `runInspect`.
    const query = toolbar.createEl("input", {
      type: "text",
      cls: "luka-graph-query",
      placeholder: "Ask the graph…",
    });
    this.inspectEl = toolbar.createEl("button", { text: INSPECT_LABEL });
    const submit = () => {
      void this.runInspect(query.value);
    };
    this.registerDomEvent(this.inspectEl, "click", submit);
    this.registerDomEvent(query, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") submit();
    });

    // §9's "PNG export button".
    const exportEl = toolbar.createEl("button", { text: "Export PNG" });
    this.registerDomEvent(exportEl, "click", () => {
      this.exportPng();
    });

    // §9: "Esc clears overlay". On the container rather than the canvas so it
    // works wherever focus sits inside the pane.
    this.registerDomEvent(root, "keydown", (event: KeyboardEvent) => {
      if (event.key !== "Escape" || this.overlay === null) return;
      event.preventDefault();
      this.setOverlay(null);
    });
    // Focusable, or the container never receives the key at all.
    root.tabIndex = -1;

    this.bannerEl = root.createDiv({ cls: "luka-graph-banner" });
    this.bannerEl.hide();
    this.statusEl = root.createDiv({ cls: "luka-graph-status" });

    // §9's scrubber. It sits between the status line and the canvas rather
    // than in the toolbar because it belongs to the overlay the status line is
    // naming, and because it is absent far more often than it is present.
    this.scrubEl = root.createDiv({ cls: "luka-graph-scrub" });
    const slider = this.scrubEl.createEl("input", {
      type: "range",
      cls: "luka-graph-scrub-slider",
    });
    slider.min = "0";
    slider.step = "1";
    this.sliderEl = slider;
    this.scrubLabelEl = this.scrubEl.createDiv({ cls: "luka-graph-scrub-label" });
    this.scrubEl.hide();
    // One scheduled frame per event (S24), and no model call: the vectors were
    // retained by the walk that built this overlay, so scrubbing is arithmetic
    // over data already in hand.
    this.registerDomEvent(slider, "input", () => {
      const overlay = this.overlay;
      if (overlay?.scrub === undefined) return;
      this.setOverlay(scrubTo(overlay, Number(slider.value), this.topK()));
    });

    this.bodyEl = root.createDiv({ cls: "luka-graph-body" });

    // §7.1's rebuild signal. Subscribed before the first load so a compile that
    // finishes mid-load is not missed.
    this.unsubscribe = this.core.onGraphRebuilt((graph) => {
      if (this.closed) return;
      this.graph = graph;
      // Same reasoning as `reload`: a new snapshot retires the old overlay.
      this.overlay = null;
      this.render();
    });

    // A theme switch changes no data, so it schedules a repaint and nothing
    // else — that is what §15's dark/light criterion needs.
    this.registerEvent(this.app.workspace.on("css-change", () => this.schedule()));

    await this.reload();
  }

  override async onClose(): Promise<void> {
    this.closed = true;
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
    this.scrubEl = null;
    this.sliderEl = null;
    this.scrubLabelEl = null;
    this.replayEl = null;
    this.inspectEl = null;
    this.press = null;
    this.panFrom = null;
    this.hovered = null;
    this.overlay = null;
    this.beforeClick = null;
    this.filter = "";
    this.graph = null;
    this.contentEl.empty();
  }

  /**
   * Re-reads the snapshot and redraws.
   *
   * A rejection is reported rather than thrown into Obsidian's event loop:
   * `getGraph` walks the vault, and one unreadable file under `wiki/` is
   * enough to reject it. That is a known compile-side gap logged against its
   * own milestone; what the pane owes is to say so.
   *
   * A pane already drawing a graph keeps it. The walk failed, not the snapshot
   * on screen, and replacing a drawn vault with "no graph yet" would report an
   * emptiness that is not true — the worse half of a failure the notice has
   * already told the user about. A pane with nothing drawn yet still shows the
   * empty state, because that one is accurate.
   *
   * Forced only from the Refresh button. Opening the pane reads the cache:
   * §15's "opens under a second" is a promise about the cached snapshot, and
   * the plugin already walked the vault at load.
   */
  private async reload(force = false): Promise<void> {
    let next: GraphSnapshot;
    try {
      next = await this.core.getGraph(force ? { force: true } : {});
    } catch (error) {
      new Notice(`Luka: could not read the graph — ${message(error)}`, 6000);
      if (!this.closed && this.graph === null) this.render();
      return;
    }
    // The view may have closed while that walk ran.
    if (this.closed) return;
    this.graph = next;
    // A refresh redraws a snapshot the overlay may predate: its paths can be
    // gone and its scores were computed against a different edge set. The
    // filter survives because it is a predicate over whatever is on screen
    // rather than a result computed from a particular graph — §9 says only
    // that Esc clears the overlay, so this pairing is ours.
    this.overlay = null;
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
      this.syncScrub();
      // §9's two states are exclusive: an empty vault is pointed at Compile, not
      // told its link ratio.
      this.bannerEl.hide();
      this.bodyEl.empty();
      this.bodyEl.createDiv({ cls: "luka-graph-empty", text: EMPTY_VAULT_MESSAGE });
      return;
    }

    this.statusEl.setText(this.statusText());
    this.syncScrub();
    this.syncBanner(graph);

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
      // Recorded, not started. Which gesture this is depends on travel that has
      // not happened yet, and `dragStart` reheats and pins — neither of which
      // §9 asks a click for.
      this.press = pressOn(node.path, point.x, point.y);
    });

    this.registerDomEvent(canvas, "pointermove", (event: PointerEvent) => {
      const frame = this.currentFrame();
      if (frame === null) return;
      const point = at(event);

      const press = this.press;
      const sim = this.sim;
      if (press !== null) {
        const held = sim?.nodeAt(press.path);
        // Gone: a compile replaced the node set mid-gesture. Ending it is
        // honest — there is nothing left to follow the pointer.
        if (sim === null || held === undefined) {
          if (press.begun) sim?.dragEnd();
          this.press = null;
          return;
        }
        // The drag starts here, on the first move past `CLICK_SLOP`, and until
        // then this branch only swallows the move: the press is still a click.
        if (!pressMoved(press, sim, held, point.x, point.y)) return;
        const graphPoint = toGraph(this.camera, point.x, point.y);
        sim.dragTo(held, graphPoint.x, graphPoint.y);
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
      const press = this.press;
      const sim = this.sim;
      this.press = null;
      this.panFrom = null;

      // A press that never began a drag is a click. §9 gives the two gestures
      // different jobs on the same button, and `press.ts` is where they are
      // told apart — releasing a drag runs no PPR (checklist §7.6), and a drag that has
      // begun is still one however near its origin it is let go.
      if (press === null || sim === null) return;
      const point = at(event);
      const clicked = pressEnded(press, sim, point.x, point.y);
      if (clicked === null) return;
      // §9 wants this "instant", so it runs on the press rather than waiting to
      // learn whether a second one is coming. Two earlier attempts to suppress
      // the first half of a double-click were both wrong — `event.detail` is 0
      // on `pointerup` so that guard never fired, and a 250ms deferral is
      // shorter than the 500ms platform double-click interval so it fired
      // anyway, on top of delaying every ordinary click. `dblclick` undoes the
      // overlay instead, which needs no timer and cannot be mistimed.
      void this.runClickPPR(clicked);
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
      // The presses that opened this gesture each ran a click-PPR on the way
      // past. Neither was asked for, so the pane goes back to what it was
      // showing — which may be nothing, or may be an Inspect or replay overlay
      // the user put there deliberately.
      this.clickEpoch += 1;
      this.setOverlay(this.beforeClick);
      this.beforeClick = null;
      // The active leaf: §8.3 asks for a new one, and only for answer notes.
      void this.app.workspace.openLinkText(node.path, "", false);
    });
  }

  /**
   * §9's "Inspect (1 model call)": overlay §7.4 steps 1–3 for a question.
   *
   * The button is disabled while the call is in flight. §16 rules out session
   * state, so there is no queue and no history — a second press before the
   * first returns would be a second call the label did not promise.
   */
  private async runInspect(question: string): Promise<void> {
    const asked = question.trim();
    if (asked === "") return;
    if (this.graph === null || this.graph.nodes.length === 0) {
      // §9 points an empty vault at Compile. Spending a model call to overlay
      // a graph that does not exist would contradict the pointer beside it.
      new Notice("Luka: no graph to inspect yet. Run Luka: Compile.", 6000);
      return;
    }
    if (this.inspecting) return;
    this.inspecting = true;
    const button = this.inspectEl;
    if (button !== null) button.disabled = true;
    try {
      const result = await this.core.inspect(asked, { snapshots: true });
      if (this.closed) return;
      // Mode A ranks lexically and returns no vectors, so it gets no slider —
      // the same absence §9 explains with "without a PPR heat ramp".
      this.setOverlay(
        withScrub(fromInspect(result, this.topK(), asked), {
          scores: new Map(result.ranked.map((node) => [node.path, node.score])),
          iterations: result.iterations ?? 0,
          ...(result.snapshots === undefined ? {} : { snapshots: result.snapshots }),
        }),
      );
      if (result.ranked.length === 0) {
        new Notice("Luka: that question reached nothing in this graph.", 6000);
      }
    } catch (error) {
      // The overlay is left alone: a failed inspection should not clear what
      // the user was already looking at.
      new Notice(`Luka: inspect failed — ${message(error)}`, 6000);
    } finally {
      this.inspecting = false;
      if (button !== null) button.disabled = false;
    }
  }

  /**
   * §9's PNG export.
   *
   * Rendered again at `PNG_SCALE` rather than lifted off the on-screen canvas,
   * so the file is crisp rather than whatever the display's pixel ratio
   * happened to be. `draw` fills the theme background before anything else,
   * which is what keeps the file opaque — an exported canvas inherits nothing
   * from the page, and a transparent PNG reads as broken on a dark backdrop.
   *
   * The file goes to the OS download path, not into the vault. §9 asks for an
   * export button and says nothing about where; a vault write would put a
   * binary the user did not ask for inside the tree compile walks, and §0 takes
   * the smaller option.
   */
  private exportPng(): void {
    const frame = this.currentFrame();
    if (frame === null || frame.width === 0 || frame.height === 0) {
      new Notice("Luka: nothing to export yet.", 6000);
      return;
    }

    const offscreen = document.createElement("canvas");
    offscreen.width = Math.round(frame.width * PNG_SCALE);
    offscreen.height = Math.round(frame.height * PNG_SCALE);
    const ctx = offscreen.getContext("2d");
    if (ctx === null) {
      new Notice("Luka: this platform gave no canvas to export with.", 6000);
      return;
    }

    // Same frame, different device ratio: the camera and the overlay are
    // whatever is on screen, so the file matches what the user is looking at.
    draw(ctx, { ...frame, dpr: PNG_SCALE });

    offscreen.toBlob((blob) => {
      // A callback rather than an `await`, and so missed by a sweep that looked
      // only at awaits: a pane closed during encoding would still hand the user
      // a download it no longer has a view for.
      if (this.closed) return;
      if (blob === null) {
        new Notice("Luka: could not encode the image.", 6000);
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `luka-graph-${stamp(new Date())}.png`;
      link.click();
      // The blob is held alive by the URL until this runs; without it the
      // export leaks a copy of every image for the life of the window.
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  /**
   * §9's maturity banner: below §7.3's predicate, say so, with live counts.
   *
   * The predicate comes from `modeOf` on the façade rather than a copy of "≥ 20
   * nodes and ≥ 1.5 link pairs per node" here. A second copy is one that can
   * disagree with the one retrieval actually uses, and the banner's whole job is
   * to report which of them a query would get.
   */
  private syncBanner(graph: GraphSnapshot): void {
    if (modeOf(graph, normalizeSettings(this.settings)) === "B") {
      this.bannerEl.hide();
      return;
    }
    const nodes = graph.nodes.length;
    const edges = graph.edges.length;
    const ratio = nodes === 0 ? 0 : edges / nodes;
    this.bannerEl.setText(
      // §9 fixes this string; the counts after it are what makes it actionable.
      `${MODE_A_BANNER} (${String(nodes)} nodes, ${String(edges)} link pairs, ` +
        `${ratio.toFixed(2)} per node)`,
    );
    this.bannerEl.show();
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
      const text = await this.host.readNote(answerPath);
      if (this.closed) return;
      trace = parseTrace(text).trace;
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

    if (this.closed) return;
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
    const epoch = this.clickEpoch;
    // Only the first press of a run records what it is replacing; the second
    // would otherwise record the first one's own overlay.
    if (this.overlay?.source !== "click") this.beforeClick = this.overlay;
    try {
      // §9's scrubber wants the walk's own iterations, so they are asked for
      // here and ride on the overlay — released with it, and never more than
      // §7.2's hundred.
      const result = await this.core.computePPR([path], { snapshots: true });
      if (this.closed || epoch !== this.clickEpoch) return;
      this.setOverlay(withScrub(fromClickPPR(result.scores, path, this.topK()), result));
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
    this.syncScrub();
    this.schedule();
  }

  /**
   * Shows §9's slider for an overlay that has a walk behind it, and hides it
   * for one that does not.
   *
   * Called from `render` as well as from `setOverlay`, because `reload` and the
   * rebuild subscription clear the overlay by assignment and then render: with
   * only the `setOverlay` path, a Refresh or a compile would leave the slider
   * on screen, ranging over vectors nothing is drawing any more.
   */
  private syncScrub(): void {
    const row = this.scrubEl;
    const slider = this.sliderEl;
    if (row === null || slider === null) return;

    const scrub = this.overlay?.scrub;
    if (scrub === undefined || this.graph === null || this.graph.nodes.length === 0) {
      row.hide();
      return;
    }

    // `max` before `value`: a value above the current maximum is clamped to it
    // by the platform, so setting them the other way round loses the position
    // whenever the new walk is longer than the old one.
    slider.max = String(stopsOf(scrub) - 1);
    slider.value = String(scrub.at);
    this.scrubLabelEl?.setText(scrubLabel(scrub));
    row.show();
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

/** `YYYY-MM-DD-HHmm`, UTC — `answerNotePath`'s convention, for the same reason. */
function stamp(now: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return [
    now.getUTCFullYear(),
    "-",
    two(now.getUTCMonth() + 1),
    "-",
    two(now.getUTCDate()),
    "-",
    two(now.getUTCHours()),
    two(now.getUTCMinutes()),
  ].join("");
}
