// Every notice Luka shows, and the wording of each.
//
// A compile or an ask reports once, here, from the result object the core
// returned — so what the user is told is derived from what actually happened
// rather than assembled at the call site. Counts that are zero are left out,
// and a problem names the file it happened to, because a bare total gives a
// user nothing to act on.
import { Notice } from "obsidian";
import type { AnswerResult, CompileResult } from "../core/index";

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
 * rolls up problems. The two notices that do exist are the two required
 * by design: the single notice naming unsupported files, and the
 * per-source notice when a source is skipped after failing.
 */
export function reportCompile(result: CompileResult): void {
  // A declined scope preview did nothing, so there is nothing to report about
  // the work — but which files are unsupported is a discovery fact, true
  // whether or not the user confirmed, so the notice still stands.
  notify(result.cancelled ? "compile cancelled — nothing was changed." : completionMessage(result), NOTICE_MS);

  if (result.skipped.length > 0) {
    const names = result.skipped.map((skipped) => `${skipped.path} — ${skipped.reason}`);
    new Notice(`Luka skipped:\n${names.join("\n")}`, NOTICE_MS);
  }

  if (result.cancelled) return;

  // A failed source is skipped with a notice. Not always an ingest —
  // a source can also fail because a page it cites could not be regenerated or
  // a page it left behind could not be deleted — so the wording names the
  // outcome the two share.
  for (const failure of result.failed) {
    notify(`skipped ${failure.path} — ${failure.reason}`, NOTICE_MS);
  }

  // Not skipped — done, differently. A rename that had to re-extract got its
  // markdown at the cost of a model call, and a file Luka declined to remove is
  // still sitting in `raw/`. Neither retries, so neither would ever be
  // mentioned again if it were not mentioned now.
  for (const entry of result.reported) {
    notify(`${entry.path} — ${entry.reason}`, NOTICE_MS);
  }
}

/**
 * The answer, once written. The mode and the grounding are the two things a
 * reader cannot see at a glance but will want to know before trusting it.
 */
export function reportAnswer(result: AnswerResult): void {
  const grounding = result.grounded
    ? `mode ${result.mode}`
    : `mode ${result.mode}, not grounded in your wiki`;
  const rounds = result.round2 ? ", after a follow-up round" : "";
  notify(`answered — ${grounding}${rounds}.`);
}

function completionMessage(result: CompileResult): string {
  const worked = result.added + result.modified + result.renamed + result.deleted > 0;
  if (!worked) return "nothing to do — no sources changed.";
  // Deletion is the most destructive thing compile does, and the user approved
  // it against a list of pages that only *might* go. Saying how many actually
  // went closes that loop. This is not invariant 4's forbidden ingest report:
  // it counts what compile did, not the problems it found.
  const removed: string[] = [];
  if (result.pagesDeleted > 0) removed.push(`${plural(result.pagesDeleted, "page")}`);
  // `raw/` is the user's own folder. A compile that took a file out of it says
  // so, even though the scope preview lists only pages.
  if (result.derivativesDeleted > 0) {
    removed.push(`${plural(result.derivativesDeleted, "file")} from raw/`);
  }
  return removed.length === 0
    ? "compile finished."
    : `compile finished — removed ${removed.join(" and ")}.`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
