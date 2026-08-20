import { App, PluginSettingTab, Setting } from "obsidian";
import { PROVIDER_TASKS } from "../core/types";
import type LukaPlugin from "./main";

const TASK_LABELS: Record<string, string> = {
  inventory: "Inventory",
  "page-generation": "Page generation",
  "seed-selection": "Seed selection",
  synthesis: "Synthesis",
  vision: "Vision",
};

export class LukaSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: LukaPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Sent only to the configured provider endpoint. Never written into the vault.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-ant-…")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl).setName("Models").setHeading();

    for (const task of PROVIDER_TASKS) {
      new Setting(containerEl).setName(TASK_LABELS[task] ?? task).addText((text) =>
        text
          .setPlaceholder("model id")
          .setValue(this.plugin.settings.models[task])
          .onChange(async (value) => {
            this.plugin.settings.models[task] = value.trim();
            await this.plugin.saveSettings();
          }),
      );
    }
  }
}
