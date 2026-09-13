// The citation block: code-written, at page foot,
// idempotently regenerated. Every wiki page has one.
//
// It is load-bearing beyond display: "The citation block is the
// persistent citer record" — a page's citing set on the next compile is read
// back out of the block written on this one. Parsing must therefore recover
// exactly what rendering wrote, for every path a user can create, and a page
// must never end up with two blocks for the next run to disagree about.

const START = "<!-- citations:start -->";
const END = "<!-- citations:end -->";

/**
 * A block is a start fence at the head of a line, the `## Sources` heading,
 * then any lines that are not themselves fences, then an end fence.
 *
 * Requiring the heading means a stray `<!-- citations:start -->` in prose
 * cannot pair with the real block and swallow the text between them. Allowing
 * arbitrary inner lines means a hand-edited block is still recognized — and so
 * still stripped and still read — rather than being left behind to accumulate.
 */
const BLOCK =
  /^<!-- citations:start -->[ \t]*\r?\n## Sources[ \t]*\r?\n(?:(?!<!-- citations:(?:start|end) -->)[^\n]*\r?\n)*<!-- citations:end -->[ \t]*$/gm;

/** Greedy, so a path containing `]` — `raw/[draft] notes.md` — round-trips. */
const ENTRY = /^-\s*\[\[(.+)\]\]\s*$/;

export interface ParsedCitations {
  /** Link targets in the order written, e.g. `raw/paper.md`. */
  entries: string[];
  /**
   * The page body with every block removed and surrounding blank space
   * normalized — removing a block that sat at the head would otherwise leave
   * the body starting with blank lines.
   */
  rest: string;
}

export function parseCitationBlock(body: string): ParsedCitations {
  const matches = [...body.matchAll(BLOCK)];
  if (matches.length === 0) return { entries: [], rest: body.trim() };

  // The last block is the one code wrote at the page foot; any earlier one is
  // stale, and reading it would hand the next compile the wrong citing set.
  const authoritative = matches[matches.length - 1] as RegExpMatchArray;
  const entries: string[] = [];
  for (const line of authoritative[0].split("\n")) {
    const entry = ENTRY.exec(line.trim());
    if (!entry) continue;
    // The whole capture is the path. `|` is a legal filename character on
    // macOS and Linux, and code never writes display text into an entry, so
    // splitting here would truncate `raw/a|b.md` to `raw/a` — a path that no
    // longer survives the citer union, silently losing the source.
    entries.push((entry[1] as string).trim());
  }

  // Every block is stripped, so regeneration cannot accumulate them.
  let rest = "";
  let cursor = 0;
  for (const match of matches) {
    rest += body.slice(cursor, match.index);
    cursor = (match.index as number) + match[0].length;
  }
  rest += body.slice(cursor);

  return { entries, rest: rest.trim() };
}

export function renderCitationBlock(entries: readonly string[]): string {
  const lines = [START, "## Sources"];
  for (const entry of clean(entries)) lines.push(`- [[${entry}]]`);
  lines.push(END);
  return lines.join("\n");
}

/**
 * Replaces any existing block and appends a fresh one at the page foot.
 * Applying this twice with the same entries yields identical bytes.
 */
export function withCitationBlock(body: string, entries: readonly string[]): string {
  const { rest } = parseCitationBlock(body);
  const block = renderCitationBlock(entries);
  return rest === "" ? `${block}\n` : `${rest}\n\n${block}\n`;
}

/**
 * First occurrence wins; callers own the ordering policy (the citer union).
 * A newline in an entry would render as two lines that no longer parse back,
 * so such an entry is dropped rather than written unreadably.
 */
function clean(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    const key = entry.trim();
    if (key === "" || key.includes("\n") || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
