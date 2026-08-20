// The link post-pass (handoff.md §4).
//
// "A code post-pass over every generated body resolves links against the
// title+alias table, rewriting `[[Alias]]` → `[[Title|Alias]]`; links that
// resolve to nothing are left untouched (they are future-article signals, not
// errors)."
import { comparePaths } from "../paths";
import type { PageMeta } from "../types";

/** Lowercased title-or-alias → canonical title. */
export type TitleIndex = ReadonlyMap<string, string>;

const WIKILINK = /\[\[([^\]\n]+)\]\]/g;

/**
 * Titles are entered first and win outright: a page's own title outranks
 * another page's alias for the same string. Among competing aliases the
 * lexicographically first title wins, so the table does not depend on the
 * order pages were discovered in.
 */
export function buildTitleIndex(pages: readonly PageMeta[]): TitleIndex {
  const ordered = [...pages].sort((a, b) => comparePaths(a.title, b.title));
  const index = new Map<string, string>();

  for (const page of ordered) index.set(page.title.toLowerCase(), page.title);
  for (const page of ordered) {
    for (const alias of page.aliases) {
      const key = alias.trim().toLowerCase();
      if (key !== "" && !index.has(key)) index.set(key, page.title);
    }
  }
  return index;
}

export function resolveLinks(body: string, index: TitleIndex): string {
  return body.replace(WIKILINK, (full: string, inner: string) => {
    const pipe = inner.indexOf("|");
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    const display = pipe === -1 ? undefined : inner.slice(pipe + 1);

    if (target === "") return full;
    // §4: links into sources are full-path and are not title-resolved.
    if (target.startsWith("raw/")) return full;
    // Heading and block references address a place inside a page, not a page.
    if (target.includes("#") || target.includes("^")) return full;

    const canonical = index.get(target.toLowerCase());
    // Unresolved is not an error — it is a future-article signal.
    if (canonical === undefined) return full;

    if (display !== undefined) return `[[${canonical}|${display}]]`;
    // Already canonical; rewriting would only add a redundant pipe.
    if (canonical === target) return full;
    return `[[${canonical}|${target}]]`;
  });
}

/** Every distinct wikilink target in a body, in first-seen order. */
export function linkTargets(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(WIKILINK)) {
    const inner = match[1] as string;
    const pipe = inner.indexOf("|");
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    if (target !== "") seen.add(target);
  }
  return [...seen];
}
