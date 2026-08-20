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

/** A derivative whose owner was renamed without the file itself moving. */
export interface RepointedDerivative {
  derivative: string;
  from: string;
  to: string;
}

/**
 * Derivatives that came through a rename still naming the source's old path.
 *
 * The file at the *new* path's derivative location is this source's derivative
 * whenever its `derived-from` is the old path — whether it never moved (an
 * extension-only rename such as `data.csv` to `data.tsv` keeps the same
 * location) or moved along with its original. Either way only the key is
 * stale, and left that way the next compile reads the source as missing its
 * derivative and then refuses to overwrite what now looks like a stranger's
 * file, failing that source on every run.
 *
 * Repointing is the same bookkeeping §6.2 asks of a rename everywhere else,
 * and it costs no model call.
 */
export async function renamedDerivatives(
  fs: FsAdapter,
  renames: readonly { from: string; to: string }[],
): Promise<RepointedDerivative[]> {
  const found: RepointedDerivative[] = [];

  for (const rename of renames) {
    const derivative = derivativeLocation(rename.to);
    // A passthrough source is its own readable markdown and has no derivative.
    if (derivative === rename.from || derivative === rename.to) continue;

    const stat = await fs.stat(derivative);
    if (stat === null || stat.kind !== "file") continue;

    try {
      const { data } = parseFrontmatter(decodeUtf8(await fs.read(derivative)));
      if (data["derived-from"] === rename.from) {
        found.push({ derivative, from: rename.from, to: rename.to });
      }
    } catch {
      continue;
    }
  }

  return found.sort((a, b) => comparePaths(a.derivative, b.derivative));
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
  stillClaimed: ReadonlySet<string> = new Set(),
): Promise<OrphanedDerivative[]> {
  const found: OrphanedDerivative[] = [];

  for (const owner of [...oldPaths].sort(comparePaths)) {
    const derivative = derivativeLocation(owner);

    if (derivative === owner) continue;
    // Sources sharing a stem share this location, so a departed `data.csv` and
    // a living `data.tsv` both point at `data.md` — and an extension-only
    // rename makes that the *same* file under both names. The derivative of a
    // source that still exists is never an orphan, whatever its `derived-from`
    // still says; the run that owns it will rewrite the key.
    if (stillClaimed.has(derivative)) continue;

    // A folder, or a file that cannot be read, is not Luka's derivative — and
    // must not take the whole compile down before any work is done.
    const stat = await fs.stat(derivative);
    if (stat === null || stat.kind !== "file") continue;

    let data: Record<string, unknown>;
    try {
      data = parseFrontmatter(decodeUtf8(await fs.read(derivative))).data;
    } catch {
      continue;
    }
    if (data["derived-from"] === owner) found.push({ derivative, owner });
  }

  return found;
}
