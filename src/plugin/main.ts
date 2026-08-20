import { Plugin } from "obsidian";
import { BusyError, createCore, type Core } from "../core/index";
import { DEFAULT_SETTINGS, type LukaSettings } from "../core/types";
import { registerCommands } from "./commands";
import { ObsidianFs } from "./fs-obsidian";
import { ObsidianHttp } from "./http-obsidian";
import { notify, progressNotice, reportCompile } from "./notices";
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
          if (event.phase === "normalizing") {
            progress.setMessage(
              `Luka: ingesting ${event.index + 1}/${event.total} — ${event.path}`,
            );
          }
        },
      });
      progress.hide();
      reportCompile(result);
    } catch (error) {
      progress.hide();
      // Invariant 2: a second invocation is refused, never queued.
      if (error instanceof BusyError) notify(`busy: ${error.operation}`);
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
