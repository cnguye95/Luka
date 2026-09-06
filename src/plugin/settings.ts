import { App, PluginSettingTab, Setting } from "obsidian";
import {
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_SETTINGS,
  PPR_EPSILON,
  PROVIDER_TASKS,
  normalizeSettings,
  type LukaSettings,
  type ProviderName,
} from "../core/types";
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

    // §12's provider selector. Read through `normalizeSettings` so a
    // hand-edited `data.json` naming something else shows the provider that
    // will actually be used, rather than a blank dropdown.
    const provider = normalizeSettings(this.plugin.settings).provider;

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Which API the model ids below belong to. Each provider keeps its own key.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ anthropic: "Anthropic", "openai-compatible": "OpenAI-compatible" })
          .setValue(provider)
          .onChange(async (value) => {
            this.plugin.settings.provider = value as ProviderName;
            await this.plugin.saveSettings();
            // Only the selected provider's fields are shown, so the tab is
            // rebuilt rather than left describing the other one.
            this.display();
          }),
      );

    if (provider === "openai-compatible") {
      this.secret(containerEl, "openaiApiKey", {
        name: "API key",
        desc: "Optional: a local server usually needs none. Sent only as a Bearer header to the base URL below, and never written into the vault.",
        placeholder: "sk-…",
      });

      new Setting(containerEl)
        .setName("Base URL")
        .setDesc(
          "Root of a Chat Completions API; /chat/completions is appended. Local servers such as Ollama use http://localhost:11434/v1.",
        )
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_OPENAI_BASE_URL)
            .setValue(this.plugin.settings.openaiBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.openaiBaseUrl = value.trim();
              await this.plugin.saveSettings();
            }),
        );
    } else {
      this.secret(containerEl, "apiKey", {
        name: "Anthropic API key",
        desc: "Sent only to the configured provider endpoint. Never written into the vault.",
        placeholder: "sk-ant-…",
      });
    }

    new Setting(containerEl)
      .setName("Models")
      .setDesc("Model ids must belong to the selected provider; the defaults are Anthropic's.")
      .setHeading();

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

    new Setting(containerEl).setName("Retrieval").setHeading();

    this.number(containerEl, "contextBudgetTokens", {
      name: "Context budget",
      desc: "Tokens of source text one answer may be built from (§7.4). Roughly characters ÷ 4.",
    });
    this.number(containerEl, "assemblyCap", {
      name: "Pages per answer (K)",
      desc: "How many whole pages an answer may assemble, budget permitting.",
    });
    this.number(containerEl, "modeMinNodes", {
      name: "Graph mode: minimum nodes",
      desc: "Below this the wiki is ranked by keyword rather than by the graph (§7.3).",
    });
    this.number(containerEl, "modeMinLinkRatio", {
      name: "Graph mode: minimum links per node",
      desc: "Both this and the node count must be met before graph ranking is used.",
    });

    new Setting(containerEl)
      .setName("Follow-up round")
      .setDesc("Let one answer ask for more pages when the first pass says something is missing (§8.2).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.followUpEnabled).onChange(async (value) => {
          this.plugin.settings.followUpEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    // §12 asks for the PPR parameters "collapsed"; `details` is the platform's
    // own disclosure and needs no stylesheet, which §3 leaves us without.
    const advanced = containerEl.createEl("details");
    advanced.createEl("summary", { text: "Advanced (PageRank)" });

    this.number(advanced, "pprAlpha", {
      name: "Damping (α)",
      desc: "How far the walk wanders before restarting at the seeds. Between 0 and 1.",
    });
    this.number(advanced, "pprMaxIterations", {
      name: "Maximum iterations",
      desc: "A ceiling; the walk normally stops earlier, when it stops moving.",
    });
    new Setting(advanced)
      .setName("Convergence threshold (ε)")
      .setDesc("Fixed by §17 — shown because the walk's stopping rule is worth knowing, not because it is tunable.")
      .addText((text) => {
        text.setValue(String(PPR_EPSILON)).setDisabled(true);
      });
  }

  /** One masked key field. Trimmed on the way in, like every other key. */
  private secret(
    parent: HTMLElement,
    key: "apiKey" | "openaiApiKey",
    labels: { name: string; desc: string; placeholder: string },
  ): void {
    new Setting(parent)
      .setName(labels.name)
      .setDesc(labels.desc)
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder(labels.placeholder)
          .setValue(this.plugin.settings[key])
          .onChange(async (value) => {
            this.plugin.settings[key] = value.trim();
            await this.plugin.saveSettings();
          });
      });
  }

  /**
   * One numeric setting.
   *
   * Written back only when the field parses as a number, so a half-typed value
   * does not land in `data.json` mid-keystroke. Anything that still gets
   * through is caught by `normalizeSettings`, which is where the rule for a
   * hand-edited file lives — this is a convenience, not the guard.
   */
  private number(
    parent: HTMLElement,
    key: NumericSetting,
    labels: { name: string; desc: string },
  ): void {
    new Setting(parent)
      .setName(labels.name)
      .setDesc(labels.desc)
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS[key]))
          .setValue(String(this.plugin.settings[key]))
          .onChange(async (value) => {
            const parsed = Number(value.trim());
            if (value.trim() === "" || !Number.isFinite(parsed)) return;
            this.plugin.settings[key] = parsed;
            await this.plugin.saveSettings();
          }),
      );
  }
}

/** The settings this tab edits as numbers. */
type NumericSetting = {
  [K in keyof LukaSettings]: LukaSettings[K] extends number ? K : never;
}[keyof LukaSettings];
