import { App, Modal, Setting } from "obsidian";
import type { ScopePreview } from "../core/index";
import { stem } from "../core/paths";

/**
 * §6.6's confirm modal: "show the scope preview (counts + lists of pages to
 * regenerate and pages that may be deleted)".
 *
 * The core holds the operation lock across this, so the vault cannot change
 * under the preview while it is on screen (§8.1).
 */
export function confirmScope(app: App, preview: ScopePreview): Promise<boolean> {
  return new Promise((resolve) => {
    new ScopeModal(app, preview, resolve).open();
  });
}

class ScopeModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly preview: ScopePreview,
    private readonly respond: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, preview } = this;
    contentEl.createEl("h3", { text: "Luka: compile scope" });
    contentEl.createEl("p", { text: diffLine(preview) });

    this.section("Pages to regenerate", preview.regenerate);
    this.section("Pages that may be deleted", preview.mayDelete);

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Compile")
          .setCta()
          .onClick(() => this.finish(true)),
      )
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.finish(false)));
  }

  private section(heading: string, paths: readonly string[]): void {
    this.contentEl.createEl("h4", { text: `${heading} (${paths.length})` });
    if (paths.length === 0) {
      this.contentEl.createEl("p", { text: "None." });
      return;
    }
    const list = this.contentEl.createEl("ul");
    // §4 makes the filename the title, so the stem is the page's name.
    for (const path of paths) list.createEl("li", { text: stem(path) });
  }

  private finish(confirmed: boolean): void {
    this.answered = true;
    this.respond(confirmed);
    this.close();
  }

  override onClose(): void {
    this.contentEl.empty();
    // Esc or a click outside is a decision not to proceed; the promise has to
    // settle either way or compile would hold the lock forever.
    if (!this.answered) {
      this.answered = true;
      this.respond(false);
    }
  }
}

function diffLine(preview: ScopePreview): string {
  const parts = [
    `${preview.added} new`,
    `${preview.modified} modified`,
    `${preview.deleted} deleted`,
    `${preview.renamed} renamed`,
    `${preview.unchanged} unchanged`,
  ];
  return parts.join(" · ");
}
