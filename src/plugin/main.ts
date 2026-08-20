import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, type LukaSettings } from "../core/types";
import { LukaSettingTab } from "./settings";

export default class LukaPlugin extends Plugin {
  override settings: LukaSettings = { ...DEFAULT_SETTINGS };

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new LukaSettingTab(this.app, this));
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
