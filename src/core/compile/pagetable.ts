// The in-memory page table (handoff.md §4: "generated each compile from the
// in-memory page table, which is built from wiki frontmatter") plus §4's
// identity and naming rules.
//
// A page's title is its filename stem: §4 makes the filename the sanitized
// title, and no frontmatter key carries it.
import type { FsAdapter } from "../adapters";
import { decodeUtf8 } from "../hash";
import { comparePaths, extname, isInfrastructure, stem } from "../paths";
import type { PageKind, PageMeta } from "../types";
import { parseFrontmatter } from "../yaml";

export const WIKI_FOLDER = "wiki";

const KINDS: readonly PageKind[] = ["source", "entity", "concept"];

/** Characters §4 strips from a title to make a filename. */
// §4 names the characters a title may not contain, which is about wikilink
// and path syntax. A filename has its own refusals on top of that — `?`, `*`,
// quotes, angle brackets and control characters are rejected outright by
// Windows — and a title that reaches the write unusable does not cost one page:
// every source citing it is blocked, so nothing in the run is manifested, and
// because inventory runs at temperature 0 the model returns the same title on
// the next compile. Being stricter than §4 is not a deviation from it.
// Control characters are in the class on purpose: a model can return one,
// and a filename carrying it is rejected outright rather than merely ugly.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[[\]#^|\\/:?*"<>\u0000-\u001f]/g;
/** Comfortably inside the 255-byte component limit, with room for `-2.md`. */
const MAX_TITLE_LENGTH = 120;

export async function loadPageTable(fs: FsAdapter): Promise<PageMeta[]> {
  const pages: PageMeta[] = [];
  const directories = [WIKI_FOLDER];

  while (directories.length > 0) {
    const directory = directories.pop() as string;
    for (const entry of await fs.list(directory)) {
      // Invariant 8 and §7.1's "every file under wiki/ (minus `_`-prefixed)":
      // the prefix marks infrastructure, and a `_`-prefixed folder holds
      // infrastructure too — nothing inside it is a page.
      if (isInfrastructure(entry.path)) continue;
      if (entry.kind === "folder") {
        directories.push(entry.path);
        continue;
      }
      if (extname(entry.path) !== ".md") continue;

      const page = toPage(entry.path, decodeUtf8(await fs.read(entry.path)));
      if (page !== null) pages.push(page);
    }
  }

  return pages.sort((a, b) => comparePaths(a.path, b.path));
}

function toPage(path: string, text: string): PageMeta | null {
  const { data } = parseFrontmatter(text);
  const kind = data["kind"];
  // A file under wiki/ without a recognizable kind is not a page Luka wrote.
  if (typeof kind !== "string" || !KINDS.includes(kind as PageKind)) return null;

  const source = sourceTarget(data["source"]);
  return {
    path,
    title: stem(path),
    kind: kind as PageKind,
    aliases: toStringArray(data["aliases"]),
    summary: typeof data["summary"] === "string" ? data["summary"] : "",
    updated: typeof data["updated"] === "string" ? data["updated"] : "",
    ...(source === null ? {} : { source }),
  };
}

/**
 * §4 writes a source page's origin as `source: "[[raw/<file>]]"`. The brackets
 * are there to make the graph an edge (§7.1); the path inside is what a
 * re-ingested source matches against, so it is unwrapped here.
 */
function sourceTarget(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^\s*\[\[(.+)\]\]\s*$/.exec(value);
  // The whole capture is the path: code writes `[[<path>]]` with no display
  // text, and `|` is legal in a filename, so splitting on it would truncate
  // the path and orphan the page from the source it describes.
  const target = (match ? (match[1] as string) : value).trim();
  return target === "" ? null : target;
}

function toStringArray(value: unknown): string[] {
  // `aliases: Ada` is as common in a hand-written vault as a proper list, and
  // dropping it would cost §6.5's dedup a match and create a duplicate page.
  if (typeof value === "string") return value.trim() === "" ? [] : [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim());
}

/**
 * §4: strip `[]#^|\/:`, and strip leading `_` and `.` so no generated page can
 * collide with the infrastructure prefix.
 */
export function sanitizeTitle(title: string): string {
  const cleaned = title
    // One Unicode form. NFC and NFD spell the same word differently but name
    // the same file on macOS, so without this two pages collapse into one and
    // the second write destroys the first, silently.
    .normalize("NFC")
    .replace(FORBIDDEN, "")
    .replace(/\s+/g, " ")
    .replace(/^[_.\s]+/, "")
    .trim();
  if (cleaned === "") return "Untitled";
  // Trailing dots and spaces are also refused by Windows, and trimming the
  // length can expose one.
  const bounded = cleaned.slice(0, MAX_TITLE_LENGTH).replace(/[.\s]+$/, "");
  return bounded === "" ? "Untitled" : bounded;
}

/**
 * §4: unique across `wiki/`. Compared case-insensitively because the vault may
 * sit on a case-insensitive filesystem, where two titles differing only in case
 * would be one file. Collisions take the §8.4 suffix idiom: `-2`, `-3`, …
 */
export function uniqueTitle(title: string, taken: ReadonlySet<string>): string {
  if (!taken.has(title.toLowerCase())) return title;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${title}-${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The set `uniqueTitle` expects, built from an existing table. */
export function takenTitles(pages: readonly PageMeta[]): Set<string> {
  return new Set(pages.map((page) => page.title.toLowerCase()));
}

/** Vault path for a page of a given kind, per §4's folder layout. */
export function pagePathForKind(title: string, kind: PageKind): string {
  const folder = kind === "source" ? "sources" : kind === "entity" ? "entities" : "concepts";
  return `${WIKI_FOLDER}/${folder}/${title}.md`;
}
