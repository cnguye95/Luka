// The §6.6 deletion / modification cascade, and §5's scope preview.
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
import type { FsAdapter } from "../adapters";
import { decodeUtf8 } from "../hash";
import { comparePaths, dirname, joinPath, stem } from "../paths";
import type { PageMeta } from "../types";
import { parseFrontmatter } from "../yaml";
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
    ...discovery.renamed.flatMap((rename) => [rename.from, rename.to]),
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

/** A derivative left behind by a source that is no longer at `owner`. */
export interface OrphanedDerivative {
  derivative: string;
  /** The departed source path — so a failed delete can block exactly it. */
  owner: string;
}

/**
 * Derivatives orphaned by sources leaving their old path, whether deleted or
 * renamed away. M1 left these behind deliberately ("deleting orphaned
 * derivatives is cascade work"); this is that work.
 *
 * The candidate is §6.1's location — `<original-stem>.md` beside the original —
 * computed without consulting the format, because a deleted repo directory has
 * no extension to read one from and the file is gone either way. Content is
 * what makes it safe: only a file whose `derived-from` names this exact
 * departed path is Luka's to delete (invariant 7). A passthrough source is its
 * own readable markdown and has no derivative, so it is skipped outright.
 */
export async function orphanedDerivatives(
  fs: FsAdapter,
  oldPaths: readonly string[],
): Promise<OrphanedDerivative[]> {
  const found: OrphanedDerivative[] = [];

  for (const owner of [...oldPaths].sort(comparePaths)) {
    const directory = dirname(owner);
    const name = `${stem(owner)}.md`;
    const derivative = directory === "" ? name : joinPath(directory, name);

    if (derivative === owner) continue;
    if (!(await fs.exists(derivative))) continue;

    const { data } = parseFrontmatter(decodeUtf8(await fs.read(derivative)));
    if (data["derived-from"] === owner) found.push({ derivative, owner });
  }

  return found;
}
