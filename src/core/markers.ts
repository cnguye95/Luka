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

/**
 * A deliberate render bound, not a suspicion about an extraction.
 *
 * §6.5 scopes `normalization suspect` to PDF-derived text, and the smell test
 * is its only other producer — a descriptor that shows 200 of 4,000 columns
 * has not been extracted badly, it has been summarized. Placed at the point of
 * the omission like `repo file omitted`, rather than at the head of the file
 * where §6.5 puts suspect markers.
 */
export function datasetColumnsOmitted(shown: number, total: number): string {
  return `<!-- dataset columns omitted: showing ${shown} of ${total} -->`;
}

export function normalizationSuspect(reasons: readonly string[]): string {
  return `<!-- normalization suspect: ${inComment(reasons.join("; "))} -->`;
}

/**
 * A citing source that reached the model with nothing in it.
 *
 * Its own marker rather than the budget one: §4 fixes that marker's wording to
 * "truncated for context budget", and an empty file under a 40,000-token
 * budget was neither truncated nor over budget. One marker per problem, and
 * this is a different problem.
 */
export function sourceWithoutContent(sources: readonly string[]): string {
  return `<!-- source with no content: ${inComment(sources.join(", "))} -->`;
}

/**
 * §6.5's budget marker. Naming sources is optional because `tokens.ts` marks
 * a cut inside a prompt, where there is nothing to name; a page marks which
 * of its citers the model did not receive in full, so it never claims
 * grounding that code wrote into its citation block and the model never saw.
 * The names go *inside* the comment, like every other marker's payload.
 */
export function truncatedForContextBudget(sources: readonly string[] = []): string {
  if (sources.length === 0) return "<!-- truncated for context budget -->";
  return `<!-- truncated for context budget: ${inComment(sources.join(", "))} -->`;
}

export function linkOutsideRetrievedSet(target: string): string {
  return `<!-- link outside retrieved set: ${inComment(target)} -->`;
}
