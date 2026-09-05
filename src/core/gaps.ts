// §10's link resolution, shared.
//
// The health check's "article candidates" and the answer note's `## Add next`
// section both ask the same question — which of a page's wikilink targets
// resolve to nothing — and §4 already answers it, in `linkTargets`, `handleOf`
// and `buildTitleIndex`. None of those is exported past the façade, so this is
// core's work rather than a caller's: a second copy of a §4 rule outside the
// boundary check is a copy that can disagree with the one compile uses, and
// then §10's report and the answer's section disagree about the same vault.
//
// Counting only. §16 forbids an LLM-driven health check and nothing here asks
// a model anything.
import type { FsAdapter } from "./adapters";
import { decodeUtf8 } from "./hash";
import { comparePaths } from "./paths";
import { buildTitleIndex, linkTargets } from "./compile/links";
import { handleOf } from "./compile/pagetable";
import { parseCitationBlock } from "./compile/citations";
import type { PageMeta } from "./types";


/**
 * What resolution needs to know about the page a link was found on. A
 * `PageMeta` is one; so is an assembled node the answer already holds, which
 * is why this is narrower than either.
 */
export interface PageRef {
  path: string;
  title: string;
}

/** Links found on one page. Enough to ask which of them resolve. */
export interface LinkScan {
  page: PageRef;
  /** Every distinct wikilink target, in first-seen order. */
  targets: readonly string[];
}

/** One page's file, read once, reduced to the two things §10 needs. */
export interface PageScan extends LinkScan {
  page: PageMeta;
  targets: string[];
  /** The citation block's entries — §6.5's persistent citer record. */
  citations: string[];
}

export interface ScanResult {
  scans: PageScan[];
  /**
   * Pages whose file could not be read. Counted rather than thrown: this runs
   * outside the operation lock, so a compile rewriting `wiki/` underneath it is
   * expected, and one unreadable page should cost that page's contribution
   * rather than the whole report.
   */
  unreadable: number;
}

/**
 * One read per page.
 *
 * Both §10's report and the gap report need the same two facts about every
 * page, and before this they were read separately — the health check opened
 * every file twice for the two sections that need it.
 */
export async function scanPages(
  fs: FsAdapter,
  pages: readonly PageMeta[],
): Promise<ScanResult> {
  const scans: PageScan[] = [];
  let unreadable = 0;

  for (const page of pages) {
    let text: string;
    try {
      text = decodeUtf8(await fs.read(page.path));
    } catch {
      unreadable += 1;
      continue;
    }
    scans.push({
      page,
      targets: linkTargets(text),
      citations: parseCitationBlock(text).entries,
    });
  }

  return { scans, unreadable };
}

export interface UnresolvedTarget {
  /** §4's one spelling rule, so `[[Zeppelin]]` and `[[zeppelin]]` are one gap. */
  handle: string;
  /**
   * The spelling to show. `comparePaths`-minimum of the raw variants seen,
   * which puts a capitalized form first — the way a page would be titled.
   */
  display: string;
  /** The pages that want it, distinct, ordered by path. */
  citers: PageRef[];
}

/**
 * §10's rule, lifted out of the health check so both consumers share it.
 *
 * Skips exactly what `articleCandidates` skipped: links into sources are
 * full-path and are not title-resolved (§4), and a heading or block reference
 * addresses a place inside a page rather than a page. What it adds is the
 * grouping key — by handle rather than by raw string, so case variants of one
 * name are one gap rather than two half-wanted ones.
 */
export function unresolvedTargets(
  pages: readonly PageMeta[],
  scans: readonly LinkScan[],
): UnresolvedTarget[] {
  const index = buildTitleIndex(pages);
  const wanted = new Map<string, { display: string; citers: Map<string, PageRef> }>();

  for (const scan of scans) {
    for (const target of scan.targets) {
      if (target.startsWith("raw/") || target.includes("#") || target.includes("^")) continue;
      const handle = handleOf(target);
      if (index.has(handle)) continue;

      const found = wanted.get(handle);
      if (found === undefined) {
        wanted.set(handle, { display: target, citers: new Map([[scan.page.path, scan.page]]) });
        continue;
      }
      // Deterministic display: the answer must not depend on which page the
      // scan reached first.
      if (comparePaths(target, found.display) < 0) found.display = target;
      found.citers.set(scan.page.path, scan.page);
    }
  }

  return [...wanted.entries()]
    .map(([handle, { display, citers }]) => ({
      handle,
      display,
      citers: [...citers.values()].sort((a, b) => comparePaths(a.path, b.path)),
    }))
    .sort((a, b) => b.citers.length - a.citers.length || comparePaths(a.display, b.display));
}
