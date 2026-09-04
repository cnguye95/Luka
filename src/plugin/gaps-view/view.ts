// "What to add next": an `ItemView` over the gap report.
//
// Not in handoff.md — the user asked for it after M4 and set its scope, which
// BUILD-NOTES records. What it owes the rest of the plugin is the same
// discipline §9's pane keeps: it holds a `Core` and no `FsAdapter`, so every
// vault read goes through the façade; it makes no model call at all; and it
// writes nothing to the vault.
//
// Invariant 1 has no watchers and no timers, and this file has neither — no
// `setTimeout`, no `setInterval`, no vault listener, and no simulation to
// schedule frames for. There are exactly three things that make it redraw: the
// command that opens it, its own Refresh button, and §7.1's graph-rebuilt
// event once the pane has been armed.
//
// "Armed" is the one rule worth stating twice. Obsidian restores an open pane
// at startup and calls `onOpen` itself, which is not a user invocation — so a
// restored pane renders a prompt and reads nothing until the user asks. This
// is invariant 1 read strictly: a vault walk nobody asked for is a vault walk
// nobody asked for, whoever called the method.
import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type { Core, GapReport, GraphSnapshot } from "../../core/index";
import { buildCards, nextDismissed, statusLine, type CardView } from "./cards";
import { drawGlyph } from "./glyph";

export const GAPS_VIEW_TYPE = "luka-gaps";

/** Before the pane has been armed. A restored pane opens here. */
const PROMPT_MESSAGE = "Press Refresh to scan the wiki for what to add next.";

/** Nothing to suggest, which on a small or a well-linked vault is the truth. */
const EMPTY_MESSAGE =
  "Nothing to add yet — every link resolves and no page rests on a single source.";

const NO_MATCH_MESSAGE = "No suggestion matches that filter.";

/**
 * How many cards reach the DOM. The filter runs over the whole report, so a
 * search still finds what the cap holds back; this only bounds the elements.
 */
const DOM_CAP = 40;

/**
 * What the pane needs from the plugin. Two functions and a getter rather than
 * the plugin itself — `main.ts` imports this module, so importing it back would
 * be a cycle, and §9's pane already takes its host this way.
 */
export interface GapsHost {
  /** Opens the Ask modal with the question already written. */
  ask(prefill: string): void;
  dismissed(): readonly string[];
  saveDismissed(keys: readonly string[]): Promise<void>;
}

export class LukaGapsView extends ItemView {
  private readonly core: Core;
  private readonly host: GapsHost;
  private unsubscribe: (() => void) | null = null;
  /** Set in `onClose`; every await checks it before touching the DOM. */
  private closed = false;
  /**
   * False until the user asks — by the command or by Refresh. A pane Obsidian
   * restored at startup has been opened by nobody.
   */
  private armed = false;
  /**
   * The snapshot the last scan ran against, by identity. The rebuilt event and
   * a forced Refresh both deliver the same object, so this is what keeps one
   * press from scanning twice.
   */
  private lastGraph: GraphSnapshot | null = null;
  /**
   * Bumped per scan. A scan whose awaits resolve after a later one started
   * drops its result rather than overwriting fresher cards with older ones —
   * the same guard §9's pane uses for a click-PPR overtaken by a double-click.
   */
  private scanEpoch = 0;
  private report: GapReport | null = null;
  private scanning = false;
  private filter = "";

  private statusEl!: HTMLElement;
  private gridEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, core: Core, host: GapsHost) {
    super(leaf);
    this.core = core;
    this.host = host;
  }

  override getViewType(): string {
    return GAPS_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "What to add next";
  }

  override getIcon(): string {
    return "lightbulb";
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("luka-gaps-view");

    const toolbar = root.createDiv({ cls: "luka-gaps-toolbar" });
    const refresh = toolbar.createEl("button", { text: "Refresh" });
    this.registerDomEvent(refresh, "click", () => {
      void this.refresh();
    });

    // The graph pane's filter idiom: a plain substring test, no debounce — a
    // debounce would be a timer, and invariant 1 has none.
    const filter = toolbar.createEl("input", {
      type: "search",
      cls: "luka-gaps-filter",
      placeholder: "Filter…",
    });
    this.registerDomEvent(filter, "input", () => {
      this.filter = filter.value;
      this.render();
    });

    this.statusEl = root.createDiv({ cls: "luka-gaps-status" });
    this.gridEl = root.createDiv({ cls: "luka-gaps-grid" });

    this.unsubscribe = this.core.onGraphRebuilt((graph) => {
      // Nothing thrown here may escape. These listeners run inside the promise
      // `compile` awaits after its writes, so an exception would be reported to
      // the user as a failed compile that in fact succeeded — and would skip
      // every listener registered after this one.
      try {
        if (this.closed || !this.armed) return;
        // The forced read the Refresh button makes arrives here first; skipping
        // the repeat is what keeps one press to one scan.
        if (graph === this.lastGraph) return;
        this.lastGraph = graph;
        void this.scan();
      } catch {
        // A pane failing to redraw is the pane's problem, never the compile's.
      }
    });

    // Deliberately no scan: see the header. The command arms it.
    this.render();
  }

  override async onClose(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.report = null;
    this.lastGraph = null;
    this.filter = "";
    this.armed = false;
    this.contentEl.empty();
  }

  /**
   * Arms the pane and reads the gap report. The open command calls this; so
   * does the rebuilt event once armed.
   */
  async scan(): Promise<void> {
    this.armed = true;
    const epoch = ++this.scanEpoch;
    this.scanning = true;
    this.render();

    try {
      const graph = await this.core.getGraph();
      if (this.closed || epoch !== this.scanEpoch) return;
      this.lastGraph = graph;
      const report = await this.core.gaps();
      if (this.closed || epoch !== this.scanEpoch) return;
      this.report = report;
    } catch (error) {
      if (this.closed || epoch !== this.scanEpoch) return;
      // `gaps()` reads the page table without a per-page guard, so a compile
      // rewriting `wiki/` underneath it can reject the whole call. Saying so is
      // better than rendering an empty gallery that reads as "nothing to add".
      new Notice(`Luka: could not scan for gaps — ${message(error)}`, 6000);
    } finally {
      if (epoch === this.scanEpoch) this.scanning = false;
    }

    if (!this.closed) this.render();
  }

  /**
   * Refresh: re-read the vault, then scan against what it says now.
   *
   * The forced rebuild publishes to every listener, and this pane's listener is
   * one of them — so in the ordinary case the scan has already started by the
   * time this resumes, and the identity check below finds nothing to do. Only a
   * build superseded by a compile arrives here unseen.
   */
  private async refresh(): Promise<void> {
    this.armed = true;
    try {
      const graph = await this.core.getGraph({ force: true });
      if (this.closed) return;
      if (graph !== this.lastGraph) {
        this.lastGraph = graph;
        await this.scan();
      }
    } catch (error) {
      if (!this.closed) new Notice(`Luka: could not read the graph — ${message(error)}`, 6000);
    }
  }

  private render(): void {
    if (this.closed) return;
    this.gridEl.empty();

    if (this.report === null) {
      this.statusEl.setText(this.scanning ? "Scanning…" : "");
      this.gridEl.createDiv({
        cls: "luka-gaps-empty",
        text: this.scanning ? "Reading the wiki…" : PROMPT_MESSAGE,
      });
      return;
    }

    const dismissed = this.host.dismissed();
    const cards = buildCards(this.report, dismissed, this.filter);
    const shown = cards.slice(0, DOM_CAP);
    this.statusEl.setText(
      statusLine({
        matched: cards.length,
        shown: shown.length,
        dismissed: dismissed.length,
        unreadable: this.report.unreadable,
      }),
    );

    if (cards.length === 0) {
      const nothingAtAll = this.report.cards.length === 0;
      this.gridEl.createDiv({
        cls: "luka-gaps-empty",
        text: nothingAtAll ? EMPTY_MESSAGE : NO_MATCH_MESSAGE,
      });
      return;
    }

    for (const card of shown) this.renderCard(card);
  }

  private renderCard(card: CardView): void {
    const el = this.gridEl.createDiv({ cls: "luka-gap-card" });
    if (card.demoted) el.addClass("luka-gap-demoted");

    const head = el.createDiv({ cls: "luka-gap-head" });
    setIcon(head.createSpan({ cls: "luka-gap-icon" }), card.icon);
    head.createSpan({ cls: "luka-gap-title", text: card.title });

    drawGlyph(el.createDiv({ cls: "luka-gap-glyph" }), card.kind, card.ring, card.title);

    // Built from elements rather than markup: the number is the one thing the
    // eye should catch, and `innerHTML` on model-written titles is not an
    // option this plugin takes anywhere.
    const reason = el.createEl("p", { cls: "luka-gap-reason" });
    reason.appendText(card.reason.before);
    reason.createEl("strong", { text: card.reason.number });
    reason.appendText(card.reason.after);

    el.createSpan({ cls: "luka-gap-chip", text: card.chip });

    const actions = el.createDiv({ cls: "luka-gap-actions" });
    const find = actions.createEl("button", { text: "Find sources" });
    this.registerDomEvent(find, "click", () => {
      void this.findSources(card);
    });
    const ask = actions.createEl("button", { text: "Ask" });
    this.registerDomEvent(ask, "click", () => {
      this.host.ask(card.askPrefill);
    });
    const dismiss = actions.createEl("button", { text: "Dismiss" });
    this.registerDomEvent(dismiss, "click", () => {
      void this.dismiss(card.key);
    });
  }

  /**
   * The query goes to the clipboard and into a notice — not to a search engine.
   *
   * Opening a browser would send page titles off the machine on a click whose
   * label does not say so, and invariant 9's only egress rule is about the API
   * key. Handing the user the query lets them decide where it goes.
   */
  private async findSources(card: CardView): Promise<void> {
    try {
      await navigator.clipboard.writeText(card.searchQuery);
      new Notice(`Luka: search copied — ${card.searchQuery}`, 8000);
    } catch {
      // The clipboard can be refused. The query is the useful part either way.
      new Notice(`Luka: search — ${card.searchQuery}`, 8000);
    }
  }

  private async dismiss(key: string): Promise<void> {
    const report = this.report;
    if (report === null) return;
    try {
      await this.host.saveDismissed(nextDismissed(report, this.host.dismissed(), key));
    } catch (error) {
      new Notice(`Luka: could not save the dismissal — ${message(error)}`, 6000);
      return;
    }
    this.render();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
