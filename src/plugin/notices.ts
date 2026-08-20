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
  // A declined scope preview did nothing, so there is nothing to report about
  // the work — but which files are unsupported is a discovery fact, true
  // whether or not the user confirmed, so §6.1's notice still stands.
  notify(result.cancelled ? "compile cancelled — nothing was changed." : completionMessage(result), NOTICE_MS);

  if (result.skipped.length > 0) {
    const names = result.skipped.map((skipped) => `${skipped.path} — ${skipped.reason}`);
    new Notice(`Luka skipped:\n${names.join("\n")}`, NOTICE_MS);
  }

  if (result.cancelled) return;

  // §11: "A failed source is skipped with a notice." Not always an ingest —
  // a source can also fail because a page it cites could not be regenerated or
  // a page it left behind could not be deleted — so the wording names the
  // outcome the two share.
  for (const failure of result.failed) {
    notify(`skipped ${failure.path} — ${failure.reason}`, NOTICE_MS);
  }
}

function completionMessage(result: CompileResult): string {
  const worked = result.added + result.modified + result.renamed + result.deleted > 0;
  if (!worked) return "nothing to do — no sources changed.";
  // Deletion is the most destructive thing compile does, and the user approved
  // it against a list of pages that only *might* go. Saying how many actually
  // went closes that loop. This is not invariant 4's forbidden ingest report:
  // it counts what compile did, not the problems it found.
  return result.pagesDeleted === 0
    ? "compile finished."
    : `compile finished — ${result.pagesDeleted} page${result.pagesDeleted === 1 ? "" : "s"} removed.`;
}
