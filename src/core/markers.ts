// The one idiom for every ingest/answer surface problem (handoff.md §4).
// Wording for images is always "not fetched", never "removed".

/**
 * Makes a value safe to sit inside an HTML comment.
 *
 * Every marker is a single `<!-- … -->`, and the values interpolated into them
 * are not Luka's: an image filename comes from a URL the model or the source
 * document supplied, and a repo path comes from whatever the user named their
 * files. A `-->` anywhere in one ends the comment early, turning the rest of
 * the marker into live markdown — a working wikilink becomes a graph edge
 * (§7.1) that nothing in the vault actually cites. Line breaks would split the
 * comment across lines for the same reason.
 */
function inComment(value: string): string {
  return value
    .replace(/\r\n?|[\n\u2028\u2029]/g, " ")
    .replace(/--+>/g, (run) => `${"-".repeat(run.length - 1)}›`)
    .trim();
}

export function imageNotFetched(name: string, reason: string): string {
  return `<!-- image not fetched: ${inComment(name)} — ${inComment(reason)} -->`;
}

export function repoFileOmitted(path: string, reason: string): string {
  return `<!-- repo file omitted: ${inComment(path)} — ${inComment(reason)} -->`;
}

export function normalizationSuspect(reasons: readonly string[]): string {
  return `<!-- normalization suspect: ${inComment(reasons.join("; "))} -->`;
}

export function truncatedForContextBudget(): string {
  return "<!-- truncated for context budget -->";
}

export function linkOutsideRetrievedSet(target: string): string {
  return `<!-- link outside retrieved set: ${inComment(target)} -->`;
}
