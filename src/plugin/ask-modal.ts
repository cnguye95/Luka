import { App, Modal, Setting } from "obsidian";

/**
 * "Luka: Ask the wiki", the modal.
 *
 * Resolves the question, or `null` when the user backs out. The promise has to
 * settle either way — the caller only takes the operation lock once it has a
 * question, but a promise left hanging would strand the command with no way
 * back, which is the failure `scope-modal.ts` settles in `onClose` to avoid.
 */
export function askQuestion(app: App): Promise<string | null> {
  return new Promise((resolve) => {
    new AskModal(app, resolve).open();
  });
}

class AskModal extends Modal {
  private answered = false;
  private question = "";

  constructor(
    app: App,
    private readonly respond: (question: string | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Luka: ask the wiki" });

    new Setting(contentEl).setName("Question").addText((text) => {
      text.setPlaceholder("What does the wiki say about…?").onChange((value) => {
        this.question = value;
      });
      // Enter submits, which is what a one-field modal should do.
      text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        this.finish(this.question);
      });
      // The field is the only thing here, so it should already be focused.
      window.setTimeout(() => text.inputEl.focus(), 0);
    });

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Ask")
          .setCta()
          .onClick(() => this.finish(this.question)),
      )
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.finish(null)));
  }

  /** An empty question is a cancellation: there is nothing to retrieve for. */
  private finish(question: string | null): void {
    const asked = question === null ? null : question.trim();
    this.answered = true;
    this.respond(asked === "" ? null : asked);
    this.close();
  }

  override onClose(): void {
    // Settle first, tidy second — Esc or a click outside is a decision not to
    // ask, and the promise has to settle or the command never returns.
    if (!this.answered) {
      this.answered = true;
      this.respond(null);
    }
    this.contentEl.empty();
  }
}
