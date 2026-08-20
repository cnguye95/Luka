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
