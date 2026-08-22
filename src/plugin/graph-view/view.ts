// §9's graph pane: an `ItemView` over the §7.1 snapshot.
//
// Read-only by construction. It holds a `Core` and no `FsAdapter`, so the only
// vault access it has is what §5's façade offers — and none of what §9 asks for
// here writes anything. It is "never blocked by the lock" for the same reason:
// every entry point it uses (`getGraph`, `computePPR`, `inspect`) is lock-free.
//
// Invariant 1 has no watchers and no timers. The pane refreshes on exactly two
// things: the graph-rebuilt event, and its own refresh button. It does not
// listen to the vault.
import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type { Core, GraphSnapshot } from "../../core/index";

export const GRAPH_VIEW_TYPE = "luka-graph";

/** §9: "empty vault → pointer at Compile." */
const EMPTY_VAULT_MESSAGE = "No graph yet. Run Luka: Compile to build one.";

export class LukaGraphView extends ItemView {
  private readonly core: Core;
  /** `onGraphRebuilt`'s unsubscribe, held so `onClose` can stop listening. */
  private unsubscribe: (() => void) | null = null;
  private graph: GraphSnapshot | null = null;

  private statusEl!: HTMLElement;
  private bodyEl!: HTMLElement;

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

    await this.reload();
  }

  override async onClose(): Promise<void> {
    // Invariant 1: nothing of this view outlives it. The simulation and its
    // frame loop join this teardown in a later step.
    this.unsubscribe?.();
    this.unsubscribe = null;
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

  private render(): void {
    const graph = this.graph;
    this.bodyEl.empty();

    if (graph === null || graph.nodes.length === 0) {
      this.statusEl.setText("");
      this.bodyEl.createDiv({ cls: "luka-graph-empty", text: EMPTY_VAULT_MESSAGE });
      return;
    }

    this.statusEl.setText(
      `${String(graph.nodes.length)} nodes, ${String(graph.edges.length)} edges`,
    );
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
