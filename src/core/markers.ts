// The one idiom for every ingest/answer surface problem (handoff.md §4).
// Wording for images is always "not fetched", never "removed".

export function imageNotFetched(name: string, reason: string): string {
  return `<!-- image not fetched: ${name} — ${reason} -->`;
}

export function repoFileOmitted(path: string, reason: string): string {
  return `<!-- repo file omitted: ${path} — ${reason} -->`;
}

export function normalizationSuspect(reasons: readonly string[]): string {
  return `<!-- normalization suspect: ${reasons.join("; ")} -->`;
}

export function truncatedForContextBudget(): string {
  return "<!-- truncated for context budget -->";
}

export function linkOutsideRetrievedSet(target: string): string {
  return `<!-- link outside retrieved set: ${target} -->`;
}

/**
 * Inserts `marker` on the line after `lineIndex`, unless it is already there.
 * Annotation has to be idempotent: a source that is re-processed (because the
 * user edited it) must not accumulate a second copy of the same marker.
 */
export function insertMarkerAfterLine(
  lines: string[],
  lineIndex: number,
  marker: string,
): string[] {
  if (lines[lineIndex + 1]?.trim() === marker) return lines;
  const out = lines.slice();
  out.splice(lineIndex + 1, 0, marker);
  return out;
}
