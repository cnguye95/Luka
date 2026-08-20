import { Notice } from "obsidian";
import type { CompileResult } from "../core/index";

const NOTICE_MS = 10_000;

export function notify(message: string, durationMs = 6000): Notice {
  return new Notice(`Luka: ${message}`, durationMs);
}

/** A notice that stays up and is updated as compile progresses. */
export function progressNotice(message: string): Notice {
  return new Notice(`Luka: ${message}`, 0);
}

/**
 * Invariant 4: ingest problems surface as inline markers in the affected file.
 * There is no ingest report and no aggregate count, so nothing here counts or
 * rolls up problems. The two notices that do exist are the ones the spec asks
 * for by name: §6.1's single notice naming unsupported files, and §11's
 * per-source notice when a source is skipped after failing.
 */
export function reportCompile(result: CompileResult): void {
  // A declined scope preview did nothing, so there is nothing to report but
  // the fact that it did nothing.
  if (result.cancelled) {
    notify("compile cancelled — nothing was changed.");
    return;
  }

  notify(completionMessage(result), NOTICE_MS);

  if (result.skipped.length > 0) {
    const names = result.skipped.map((skipped) => `${skipped.path} — ${skipped.reason}`);
    new Notice(`Luka skipped:\n${names.join("\n")}`, NOTICE_MS);
  }

  for (const failure of result.failed) {
    notify(`could not ingest ${failure.path} — ${failure.reason}`, NOTICE_MS);
  }
}

function completionMessage(result: CompileResult): string {
  const worked = result.added + result.modified + result.renamed + result.deleted > 0;
  return worked ? "compile finished." : "nothing to do — no sources changed.";
}
