import { Notice, Plugin, TFile } from "obsidian";
import { BusyError, HEALTH_PATH, createCore, type Core, type ProgressEvent } from "../core/index";
import { askQuestion } from "./ask-modal";
import { DEFAULT_SETTINGS, type LukaSettings } from "../core/types";
import { registerCommands } from "./commands";
import { ObsidianFs } from "./fs-obsidian";
import { ObsidianHttp } from "./http-obsidian";
import { notify, progressNotice, reportAnswer, reportCompile } from "./notices";
import { confirmScope } from "./scope-modal";
import { GRAPH_VIEW_TYPE, LukaGraphView } from "./graph-view/view";
import { LukaSettingTab } from "./settings";

const FALLBACK_PLUGIN_DIR = ".obsidian/plugins/luka";

export default class LukaPlugin extends Plugin {
  override settings: LukaSettings = { ...DEFAULT_SETTINGS };
  private core!: Core;

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.core = createCore({
      fs: new ObsidianFs(this.app.vault.adapter),
      http: new ObsidianHttp(),
      // Ingest state lives beside the plugin, never in the vault tree.
      manifestPath: `${this.manifest.dir ?? FALLBACK_PLUGIN_DIR}/ingest-manifest.json`,
      settings: this.settings,
    });

    this.addSettingTab(new LukaSettingTab(this.app, this));
    this.registerView(GRAPH_VIEW_TYPE, (leaf) => new LukaGraphView(leaf, this.core, this.settings));
    // §8.1: "One ribbon icon: the graph pane." The only one Luka adds.
    this.addRibbonIcon("git-fork", "Luka: Open graph", () => {
      void this.openGraph();
    });
    registerCommands(this);
    // §7.1: the graph is "built in memory at plugin load and after compile".
    // Not awaited — `onload` must not block Obsidian on a vault walk, and every
    // reader goes through `getGraph()`, which joins this build if it is still
    // running. A failure here is not fatal: the next `getGraph()` retries.
    void this.core.getGraph().catch(() => {});
  }

  async runCompile(): Promise<void> {
    const progress = progressNotice("compiling…");
    try {
      const result = await this.core.compile({
        onProgress: (event) => {
          const message = progressMessage(event);
          if (message !== null) progress.setMessage(message);
        },
        // §8.1: the lock is already held around this, so the preview cannot go
        // stale while the modal is open.
        confirm: (preview) => confirmScope(this.app, preview),
      });
      progress.hide();
      reportCompile(result);
    } catch (error) {
      progress.hide();
      // Invariant 2: a second invocation is refused, never queued, and the
      // notice text is specified verbatim — BusyError.message already is it.
      if (error instanceof BusyError) new Notice(error.message, 6000);
      else notify(`compile failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * §8.1's "Ask the wiki". The modal runs *before* the lock is taken: holding
   * it across a modal the user may leave open indefinitely would block compile
   * for no work, and §8.1 only asks compile's preview to be held that way.
   */
  async runAsk(): Promise<void> {
    const question = await askQuestion(this.app);
    if (question === null) return;

    const progress = progressNotice("asking…");
    try {
      const result = await this.core.ask(question);
      progress.hide();
      reportAnswer(result);
      // §8.3: "Open the note in a new leaf on success."
      await this.app.workspace.openLinkText(result.path, "", true);
    } catch (error) {
      progress.hide();
      // Invariant 2's wording is BusyError's own, so it bypasses the prefix.
      if (error instanceof BusyError) new Notice(error.message, 6000);
      // Invariant 11: nothing was written, so the notice says only that it
      // failed — there is no partial note to point the user at.
      else notify(`ask failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** §8.1's "Health check". No model calls (§10), so no progress notice. */
  async runHealthCheck(): Promise<void> {
    try {
      await this.core.healthCheck();
      notify("health check written to wiki/_health.md.");
      await this.app.workspace.openLinkText(HEALTH_PATH, "", true);
    } catch (error) {
      if (error instanceof BusyError) new Notice(error.message, 6000);
      else notify(`health check failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * §8.1's "Open graph": reveal the pane if it is already open, else put one in
   * the right sidebar.
   *
   * Reveal-not-duplicate because §9's pane is a view of one snapshot; a second
   * copy would be a second simulation over the same data, and the ribbon is a
   * button users press more than once.
   */
  async openGraph(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(GRAPH_VIEW_TYPE);
    const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (leaf === null) return;
    if (existing.length === 0) await leaf.setViewState({ type: GRAPH_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /** §8.4's "File this answer", on the active answer note. */
  async runFileBack(answerPath: string): Promise<void> {
    try {
      await this.core.fileBack(answerPath);
      // §8.4 pins this string, and it is deliberately not a compile trigger:
      // invariant 1 has no auto-compile.
      new Notice("Filed. Run Compile to integrate.", 6000);
    } catch (error) {
      notify(`filing failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The active file when it is an answer note Luka wrote, else `null`.
   *
   * Read from frontmatter rather than from the folder: a note the user has
   * moved is still an answer, and a file that merely sits in `answers/` is not.
   */
  activeAnswerPath(): string | null {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") return null;
    const kind = this.app.metadataCache.getFileCache(file)?.frontmatter?.["kind"] as unknown;
    return kind === "answer" ? file.path : null;
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<LukaSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(stored ?? {}),
      models: { ...DEFAULT_SETTINGS.models, ...(stored?.models ?? {}) },
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

/** `null` for phases with nothing useful to say beyond "still working". */
function progressMessage(event: ProgressEvent): string | null {
  switch (event.phase) {
    case "normalizing":
      return `Luka: ingesting ${event.index + 1}/${event.total} — ${event.path}`;
    case "inventory":
      return `Luka: reading ${event.index + 1}/${event.total} — ${event.path}`;
    case "generating":
      return `Luka: writing ${event.index + 1}/${event.total} — ${event.title}`;
    case "writing-index":
      return "Luka: writing the index…";
    default:
      return null;
  }
}
