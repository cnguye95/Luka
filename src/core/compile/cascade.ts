// §5's scope preview over the §6.6 deletion / modification cascade.
//
// Only the advisory half lives here. Locating and removing an orphaned
// derivative used to as well, by deriving `<stem>.md` from a departed path;
// ownership is recorded in the manifest now (invariant II), so the sweep reads
// the entry instead and lives with the rest of the rename work in renames.ts.
//
// "Before work: show the scope preview (counts + lists of pages to regenerate
// and pages that may be deleted) in a confirm modal. Then: affected pages
// regenerate from surviving citing sources; a page with zero remaining source
// citations is deleted; a visited set prevents reprocessing a page twice per
// run; the cascade runs to completion. Modification uses the same machinery."
//
// The cascade cannot chain. Pages cite *sources*, never other pages — a
// wikilink to a page is §4's "future-article signal", not a citation — so
// "runs to completion" is one pass over the page table, and the visited set is
// that pass keyed by page path.
//
// What this module computes is **advisory**: it answers "what would this diff
// touch" without normalizing, calling the model, or writing. The authoritative
// decision stays where it already lives, in `citerUnion` against the manifest
// this run will write — which is why §6.6's second list is pages that *may* be
// deleted: a modified or new source's inventory can still re-cite one.
import { comparePaths } from "../paths";
import type { PageMeta } from "../types";
import type { DiscoveryResult } from "./discover";

/** §5: "the four-rule diff plus cascade scope … without doing work". */
export interface ScopePreview {
  added: number;
  modified: number;
  unchanged: number;
  deleted: number;
  renamed: number;
  /** Pages citing a touched source that keep at least one surviving citer. */
  regenerate: string[];
  /** Pages whose every citer is being deleted — §6.6's "may be deleted". */
  mayDelete: string[];
}

/**
 * One pass over the page table. A page is in scope iff its citation block names
 * a source this run deletes or modifies; it is doomed iff *no* citer survives.
 */
export function cascadeScope(
  pages: readonly PageMeta[],
  citations: ReadonlyMap<string, string[]>,
  discovery: DiscoveryResult,
): ScopePreview {
  const touched = new Set<string>([
    ...discovery.deleted,
    ...discovery.modified.map((source) => source.path),
  ]);

  // Everything the manifest will still name after this run. A renamed source is
  // live under both names: the old path is repointed to the new one rather than
  // dropped, so a block still naming it has not lost its citer.
  const live = new Set<string>([
    ...discovery.added.map((source) => source.path),
    ...discovery.modified.map((source) => source.path),
    ...discovery.unchanged.map((source) => source.path),
    ...discovery.renamed.flatMap((rename) => [rename.from, rename.source.path]),
  ]);

  const regenerate: string[] = [];
  const mayDelete: string[] = [];

  for (const page of pages) {
    const entries = citations.get(page.path) ?? [];
    if (!entries.some((entry) => touched.has(entry))) continue;
    if (entries.some((entry) => live.has(entry))) regenerate.push(page.path);
    else mayDelete.push(page.path);
  }

  return {
    added: discovery.added.length,
    modified: discovery.modified.length,
    unchanged: discovery.unchanged.length,
    deleted: discovery.deleted.length,
    renamed: discovery.renamed.length,
    regenerate: regenerate.sort(comparePaths),
    mayDelete: mayDelete.sort(comparePaths),
  };
}
