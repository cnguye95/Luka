import { Notice } from "obsidian";
import type { CompileResult } from "../core/index";

const SUMMARY_MS = 10_000;

export function notify(message: string, durationMs = 6000): Notice {
  return new Notice(`Luka: ${message}`, durationMs);
}

/** A notice that stays up and is updated as compile progresses. */
export function progressNotice(message: string): Notice {
  return new Notice(`Luka: ${message}`, 0);
}

export function reportCompile(result: CompileResult): void {
  new Notice(summarize(result), SUMMARY_MS);

  // handoff.md §6.1: unsupported files get one notice naming them.
  if (result.skipped.length > 0) {
    const names = result.skipped.map((skipped) => `${skipped.path} (${skipped.reason})`);
    new Notice(`Luka skipped ${result.skipped.length} file(s):\n${names.join("\n")}`, SUMMARY_MS);
  }

  if (result.failed.length > 0) {
    const names = result.failed.map((failure) => `${failure.path} — ${failure.reason}`);
    new Notice(
      `Luka could not ingest ${result.failed.length} source(s):\n${names.join(
        "\n",
      )}\nThey will be retried on the next compile.`,
      SUMMARY_MS,
    );
  }
}

export function summarize(result: CompileResult): string {
  const counts: string[] = [];
  if (result.added > 0) counts.push(`${result.added} new`);
  if (result.modified > 0) counts.push(`${result.modified} changed`);
  if (result.renamed > 0) counts.push(`${result.renamed} renamed`);
  if (result.deleted > 0) counts.push(`${result.deleted} removed`);

  if (counts.length === 0) {
    return `Luka: nothing to do — ${result.unchanged} source(s) unchanged.`;
  }
  return `Luka: ingested ${counts.join(", ")}; ${result.unchanged} unchanged.`;
}
