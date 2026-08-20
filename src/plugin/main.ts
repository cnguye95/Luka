import { Notice, Plugin } from "obsidian";
import { BusyError, createCore, type Core, type ProgressEvent } from "../core/index";
import { DEFAULT_SETTINGS, type LukaSettings } from "../core/types";
import { registerCommands } from "./commands";
import { ObsidianFs } from "./fs-obsidian";
import { ObsidianHttp } from "./http-obsidian";
import { notify, progressNotice, reportCompile } from "./notices";
import { confirmScope } from "./scope-modal";
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
    registerCommands(this);
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
