// "What to add next": the structural gaps in a compiled wiki, ranked.
//
// Not in handoff.md. The user asked for a recommendation surface after M4 and
// set its scope; BUILD-NOTES records the decisions. What makes it Luka's rather
// than a second health check is that it is *ranked and actionable*: §10 lists
// every unresolved link as text in a report people open looking for faults,
// and the ones worth writing get read past.
//
// Two signals, both counting, neither asking a model anything (§16 forbids an
// LLM-driven health check and this is the same rule):
//
//   - a wikilink target several pages reach for that resolves to nothing — §4
//     calls it "a future-article signal, not an error", and the pages that
//     already want it are the argument for writing it;
//   - a page resting on exactly one citing source, which is where the wiki is
//     thinnest rather than merely short.
//
// The rules for both live in `src/core` already — `linkTargets`, `handleOf`,
// `buildTitleIndex`, `parseCitationBlock`, `isInfrastructure` — and none of
// them is exported past the façade. So this is core's work, not the plugin's:
// a second copy of a §4 rule outside the boundary check is a copy that can
// disagree with the one compile uses.
import type { FsAdapter } from "./adapters";
import { decodeUtf8 } from "./hash";
import { basename, comparePaths } from "./paths";
import { buildTitleIndex, linkTargets } from "./compile/links";
import { handleOf, sanitizeTitle } from "./compile/pagetable";
import { parseCitationBlock } from "./compile/citations";
import type { GraphSnapshot, PageMeta } from "./types";

/**
 * A target one page wants is a note to self; a target several pages want is a
 * hole in the wiki. Two is the smallest number that makes the distinction, and
 * on the vaults this was measured against it already cuts ten candidates to
 * two — the rest being names the model invented once and never reused.
 */
const MIN_DEMAND = 2;

/**
 * How many thin-evidence cards to keep.
 *
 * Not a display detail. On both fixture vaults *most* non-source pages cite
 * exactly one source, so the raw predicate describes the wiki's normal state
 * rather than a defect. Ranked and capped it names the few worth shoring up;
 * uncapped it would be a list of nearly every page, which is not a
 * recommendation.
 */
const THIN_CAP = 5;

/** One page's file, read once, reduced to the two things both signals need. */
export interface PageScan {
  page: PageMeta;
  /** Every distinct wikilink target in the file, in first-seen order. */
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
  citers: PageMeta[];
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
  scans: readonly PageScan[],
): UnresolvedTarget[] {
  const index = buildTitleIndex(pages);
  const wanted = new Map<string, { display: string; citers: Map<string, PageMeta> }>();

  for (const scan of scans) {
    for (const target of scan.targets) {
      if (target.startsWith("raw/") || target.includes("#") || target.includes("^")) continue;
      const handle = handleOf(target);
      if (handle === "" || index.has(handle)) continue;

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

/**
 * Degree counting only edges between wiki pages.
 *
 * `GraphNode.degree` counts every edge, and roughly half of them run to raw
 * nodes: §4 has each page's citation block link its sources, so a page that
 * cites four files carries four edges that say nothing about how central it is
 * to the wiki. "Wanted by two pages carrying seventeen links between them" has
 * to mean links to *other pages*, or the sentence is not true.
 */
export function wikiDegrees(graph: GraphSnapshot): ReadonlyMap<string, number> {
  const wiki = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind !== "raw") wiki.add(node.path);
  }

  const degrees = new Map<string, number>();
  for (const path of wiki) degrees.set(path, 0);
  for (const edge of graph.edges) {
    if (!wiki.has(edge.a) || !wiki.has(edge.b)) continue;
    degrees.set(edge.a, (degrees.get(edge.a) ?? 0) + 1);
    degrees.set(edge.b, (degrees.get(edge.b) ?? 0) + 1);
  }
  return degrees;
}

export type GapKind = "article" | "thin";

export interface GapCiter {
  path: string;
  title: string;
}

export interface GapCard {
  kind: GapKind;
  /**
   * The card's identity, and the whole of it: the gap plus the evidence for
   * it. A dismissal keyed on this expires by construction — when another page
   * starts wanting the same target, the key is a different string and the card
   * comes back, which is the "new evidence earns a return" rule with nothing to
   * implement.
   */
  key: string;
  /** The target to write (article), or the page resting on one source (thin). */
  title: string;
  /** Thin only: the page's vault path. */
  path?: string;
  /** Article: the pages that want it. Thin: the one source it rests on. */
  citers: GapCiter[];
  /** Article: how many pages want it. Thin: 1. */
  demand: number;
  /** Article: summed wiki degree of the citers. Thin: the page's own. */
  weight: number;
  /**
   * A name that looks like a code identifier, or one already contained in a
   * page's title or alias. Sorted after everything else rather than dropped —
   * `linkTargets` is what the model wrote, and these are usually noise, but
   * "usually" is not a reason for code to decide the user may not see it.
   */
  demoted: boolean;
  /** Thin only: the one citation entry the page rests on. */
  citation?: string;
}

export interface GapReport {
  /** Ranked. The order is the report's answer; nothing downstream re-sorts. */
  cards: GapCard[];
  unreadable: number;
}

/** Pure: everything it needs has already been read. */
export function gapReport(
  pages: readonly PageMeta[],
  scans: readonly PageScan[],
  graph: GraphSnapshot,
  unreadable: number,
): GapReport {
  const degrees = wikiDegrees(graph);
  // Every name the wiki already answers to, for the near-alias test below.
  const known = new Set(buildTitleIndex(pages).keys());

  const articles: GapCard[] = [];
  for (const target of unresolvedTargets(pages, scans)) {
    if (target.citers.length < MIN_DEMAND) continue;
    // A name §4's namespace would have to rewrite is not a title the user can
    // act on: `...` sanitizes to "Untitled" and `a/b` loses its slash, so
    // neither names a page that could be created under it.
    //
    // This subsumes invariant 8's prefix as well, which is why there is no
    // separate `isInfrastructure` test here: `sanitizeTitle` strips a leading
    // `_`, so every target that rule would refuse this one refuses first. A
    // second check would be code no input could make decide anything.
    if (sanitizeTitle(target.display) !== target.display) continue;

    // A citer the snapshot does not carry contributes no centrality — the
    // narrowing `runInspect` applies for the same reason — but it still counts
    // as demand and still belongs to the key, or a page written since the last
    // rebuild would expire a dismissal it had nothing to do with.
    let weight = 0;
    for (const citer of target.citers) weight += degrees.get(citer.path) ?? 0;

    articles.push({
      kind: "article",
      key: `article\n${target.handle}\n${target.citers.map((c) => c.path).join("\n")}`,
      title: target.display,
      citers: target.citers.map((c) => ({ path: c.path, title: c.title })),
      demand: target.citers.length,
      weight,
      demoted: identifierShaped(target.display) || nearKnownName(target.handle, known),
    });
  }

  articles.sort(
    (a, b) =>
      Number(a.demoted) - Number(b.demoted) ||
      b.demand * b.weight - a.demand * a.weight ||
      b.demand - a.demand ||
      comparePaths(a.title, b.title),
  );

  const thin: GapCard[] = [];
  for (const scan of scans) {
    // A source page's block cites its own raw file and nothing else (§4), so
    // every one of them has exactly one entry. Including them would make the
    // signal describe the schema rather than the wiki.
    if (scan.page.kind === "source") continue;
    if (scan.citations.length !== 1) continue;
    const citation = scan.citations[0] as string;

    thin.push({
      kind: "thin",
      key: `thin\n${scan.page.path}\n${citation}`,
      title: scan.page.title,
      path: scan.page.path,
      // Titled the way §7.1 titles a raw node, so the two panes name one file
      // the same way.
      citers: [{ path: citation, title: basename(citation) }],
      demand: 1,
      weight: degrees.get(scan.page.path) ?? 0,
      demoted: false,
      citation,
    });
  }

  thin.sort((a, b) => b.weight - a.weight || comparePaths(a.path ?? "", b.path ?? ""));

  return { cards: [...articles, ...thin.slice(0, THIN_CAP)], unreadable };
}

/**
 * A name shaped like something from a codebase rather than something from a
 * wiki. Call B's prompt tells the model to "link freely… write the natural
 * name", and on the measured vaults that produced `link_pairs`, `linkTargets`
 * and `...` alongside the real concepts.
 */
function identifierShaped(display: string): boolean {
  return display.includes("_") || /[a-z][A-Z]/.test(display) || !/\p{L}/u.test(display);
}

/**
 * Whether an existing title or alias already contains this name — `vault`
 * against a page called `vault nodes`. Usually a fragment of a name the wiki
 * covers rather than a subject of its own.
 */
function nearKnownName(handle: string, known: ReadonlySet<string>): boolean {
  for (const name of known) {
    if (name !== handle && name.includes(handle)) return true;
  }
  return false;
}
