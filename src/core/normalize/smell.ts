// The smell test (handoff.md §6.5): "PDF-derived only — flag suspiciously
// short output vs page count, repeated lines at intervals (running headers),
// high sentence-fragment ratio → marker at head of the normalized file."
//
// These are heuristics over an extraction Luka already performed, not a
// judgement about the PDF. They exist to tell the user "this extraction looks
// wrong, go repair the derivative" — §6.2 makes editing a derivative the
// sanctioned repair path. Every threshold here is a choice handoff.md leaves
// open; each is recorded in BUILD-NOTES.

/** Below this many characters per page on average, extraction looks starved. */
const MIN_CHARS_PER_PAGE = 200;

/** A line has to recur on at least this many pages to read as a running header. */
const MIN_HEADER_PAGES = 3;

/** Shorter lines repeat innocently (page numbers are handled by this too). */
const MIN_HEADER_LENGTH = 4;

/** Fragment ratio is only meaningful once there is enough text to judge. */
const MIN_LINES_FOR_FRAGMENTS = 20;

const MAX_FRAGMENT_RATIO = 0.6;

/** A line ending in any of these reads as a finished sentence or a heading. */
const TERMINAL = /[.!?:;"'”’)\]]$/;

export interface SmellInput {
  /** Per-page extracted text, in page order. */
  pages: readonly string[];
  pageCount: number;
}

/**
 * Reasons the extraction looks suspect, in a fixed order. Empty means clean.
 * The caller renders them through `normalizationSuspect`.
 */
export function smellPdfExtraction(input: SmellInput): string[] {
  const reasons: string[] = [];
  const pageCount = Math.max(input.pageCount, input.pages.length);
  if (pageCount === 0) return reasons;

  const characters = input.pages.reduce((total, page) => total + page.trim().length, 0);
  if (characters / pageCount < MIN_CHARS_PER_PAGE) {
    reasons.push(`short output for ${pageCount} page${pageCount === 1 ? "" : "s"}`);
  }

  const header = maxRepeatedPages(input.pages);
  if (header >= MIN_HEADER_PAGES) {
    reasons.push(`repeated line on ${header} pages`);
  }

  const fragments = fragmentRatio(input.pages);
  if (fragments !== null && fragments > MAX_FRAGMENT_RATIO) {
    reasons.push(`high sentence-fragment ratio (${Math.round(fragments * 100)}%)`);
  }

  return reasons;
}

/**
 * How many distinct pages the most-repeated line appears on.
 *
 * Counting *pages* rather than occurrences is what makes this a running-header
 * test: a phrase repeated three times on one page is prose, not a header.
 *
 * Only the count is returned, never the line. The marker reports the count, so
 * which of two equally-repeated lines "wins" is unobservable — and keeping the
 * winner would mean deciding a tie no caller can see. It would also invite
 * putting arbitrary extracted text into an HTML comment, where a `-->` in the
 * PDF would break out of the marker.
 */
function maxRepeatedPages(pages: readonly string[]): number {
  const pagesByLine = new Map<string, number>();

  for (const page of pages) {
    const seen = new Set<string>();
    for (const raw of page.split("\n")) {
      const line = raw.trim();
      if (line.length < MIN_HEADER_LENGTH || seen.has(line)) continue;
      seen.add(line);
      pagesByLine.set(line, (pagesByLine.get(line) ?? 0) + 1);
    }
  }

  let most = 0;
  for (const count of pagesByLine.values()) most = Math.max(most, count);
  return most;
}

/** `null` when there is too little text for the ratio to mean anything. */
function fragmentRatio(pages: readonly string[]): number | null {
  const lines = pages
    .flatMap((page) => page.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length < MIN_LINES_FOR_FRAGMENTS) return null;
  const fragments = lines.filter((line) => !TERMINAL.test(line)).length;
  return fragments / lines.length;
}
