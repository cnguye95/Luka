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
import { derivativePathFor } from "../normalize/index";
import { comparePaths, dirname, joinPath, stem } from "../paths";
import type { PageMeta, SourceFormat } from "../types";
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

/**
 * The manifest value recorded for a departed source whose cascade could not be
 * completed, so that §6.2 sees the path leave again next compile and the
 * cascade retries.
 *
 * Deliberately not a SHA-256. §6.2 identifies sources by content hash, and a
 * restored real hash would sit in the manifest for as many runs as the failure
 * lasts, waiting to pair as a rename against any unrelated file that happens to
 * share those bytes — a copied template or a second empty file would silently
 * inherit the dead path's identity and its pages. Nothing can hash to this, so
 * the entry can only ever be read as "still gone, still owed a cascade".
 */
export const CASCADE_PENDING = "cascade-pending";

/** A derivative left behind by a source that is no longer at `owner`. */
export interface OrphanedDerivative {
  derivative: string;
  /** The departed source path — so a failed delete can block exactly it. */
  owner: string;
}

/**
 * §6.1's derivative location for a source path — `<original-stem>.md` beside
 * the original — computed without the format, which a departed path no longer
 * offers. For a passthrough source this is the source itself, which is exactly
 * why the sweep skips that case.
 */
export function derivativeLocation(path: string): string {
  const directory = dirname(path);
  const name = `${stem(path)}.md`;
  return directory === "" ? name : joinPath(directory, name);
}

/** What a rename requires of the source's derivative. */
export type RenameDerivativeAction =
  | { kind: "none" }
  | { kind: "repoint"; at: string }
  | { kind: "move"; from: string; to: string }
  | { kind: "reprocess" };

/** True when the file at `path` is a derivative naming `origin` as its source. */
export async function ownedBy(fs: FsAdapter, path: string, origin: string): Promise<boolean> {
  const stat = await fs.stat(path);
  if (stat === null || stat.kind !== "file") return false;
  try {
    const { data } = parseFrontmatter(decodeUtf8(await fs.read(path)));
    return data["derived-from"] === origin;
  } catch {
    return false;
  }
}

/**
 * Where a renamed source's derivative stands, and what this run owes it.
 *
 * §6.2 says a rename updates the manifest path and skips regeneration, and it
 * separately says a derivative "persists until the original changes" — the
 * sanctioned repair path for a bad extraction. A rename does not change the
 * original: identical bytes are how it was detected. So the derivative is
 * carried over rather than rebuilt, whether it sits where the new path expects
 * it (`repoint` — an extension-only rename never moves it) or was left at the
 * old path's location (`move`, then repoint), which is what an ordinary folder
 * move produces.
 *
 * `reprocess` is the last resort: nothing usable to carry, or a file that is
 * not Luka's already occupying the destination. Only then does §6.2's
 * missing-derivative rule apply and the source re-normalize.
 *
 * Decided once — discovery calls it to classify, and the result is carried on
 * the `Rename` so compile applies exactly what was classified. Re-deriving it
 * during compile would ask a vault that compile itself has been mutating.
 */
export async function renameDerivativeAction(
  fs: FsAdapter,
  rename: { from: string; to: string; format: SourceFormat },
): Promise<RenameDerivativeAction> {
  const target = derivativePathFor(rename.to, rename.format);
  // A passthrough source is its own readable markdown and writes no derivative.
  if (target === null) return { kind: "none" };

  // Only a file naming the path the bytes actually came from is evidence. A
  // derivative already naming the *new* path is not: this source arrived there
  // only just now — that is what made it an addition to pair — so such a file
  // was written for some earlier occupant of the path and describes a
  // different document. Re-extracting overwrites it, which `claimDerivative`
  // allows because the origin it names is this very source.
  if (await ownedBy(fs, target, rename.from)) return { kind: "repoint", at: target };

  const old = derivativeLocation(rename.from);
  if (old !== target && !(await fs.exists(target)) && (await ownedBy(fs, old, rename.from))) {
    return { kind: "move", from: old, to: target };
  }

  return { kind: "reprocess" };
}

/**
 * Derivatives orphaned by sources leaving their old path, whether deleted or
 * renamed away. M1 left these behind deliberately ("deleting orphaned
 * derivatives is cascade work"); this is that work.
 *
 * The candidate is §6.1's location — `<original-stem>.md` beside the original —
 * computed without consulting the format, because a deleted repo directory has
 * no extension to read one from and the file is gone either way.
 *
 * Content, not the path, is what makes this safe: only a file whose
 * `derived-from` names this exact departed path is Luka's to delete
 * (invariant 7), so a user's own file or another source's derivative sitting
 * at the candidate path survives. A departed `.md` is skipped outright, since
 * its candidate is itself; a departed `.txt` is caught by the same
 * `derived-from` check as everything else.
 */
export async function orphanedDerivatives(
  fs: FsAdapter,
  oldPaths: readonly string[],
): Promise<OrphanedDerivative[]> {
  const found: OrphanedDerivative[] = [];

  for (const owner of [...oldPaths].sort(comparePaths)) {
    const derivative = derivativeLocation(owner);
    if (derivative === owner) continue;
    if (await ownedBy(fs, derivative, owner)) found.push({ derivative, owner });
  }

  return found;
}
