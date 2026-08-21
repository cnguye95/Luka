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
/**
 * §4's filename lives in one filesystem component, which ext4 and APFS bound
 * at 255 *bytes* — not code units. Room here for `.md`, for a `-10` suffix,
 * and slack for hosts that are stricter.
 */
const MAX_TITLE_BYTES = 200;

/**
 * The one spelling rule for §4's namespace.
 *
 * §4 gives titles and aliases one namespace, so every table keyed by a name —
 * the page table, the link index, the merge's owner map — has to agree on when
 * two strings are the same name. Built separately they drift, and a name free
 * in one table and taken in another is a page written over another page.
 *
 * NFC because a vault on APFS hands back NFD for a name Luka wrote as NFC and
 * the two are one file. `toLowerCase` rather than `toLocaleLowerCase` so the
 * answer does not depend on the host's locale. Normalized last, because
 * lowercasing can itself denormalize.
 */
export function handleOf(value: string): string {
  return value.trim().toLowerCase().normalize("NFC");
}

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
 *
 * Length is deliberately not bounded here. §6.5 matches each inventory item
 * against the page table through this function, so a bound makes it a lossy
 * key: two concepts that share a long opening become one page. The filename
 * bound belongs to `uniqueTitle`, which is what actually names a file.
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
    .trim()
    // Trailing dots and spaces are also refused by Windows.
    .replace(/[.\s]+$/, "");
  return cleaned === "" ? "Untitled" : cleaned;
}

/**
 * Cut to a UTF-8 byte budget without splitting a code point.
 *
 * Counting code units against a byte limit lets a CJK title through at three
 * bytes each and still overflow the host. Cutting between the halves of a
 * surrogate pair is worse: the lone half encodes as U+FFFD, so the name on
 * disk and the title in memory stop being the same string and every table
 * keyed by it splits.
 */
function boundTitle(title: string, budget: number): string {
  let used = 0;
  let cut = 0;
  for (const point of title) {
    const code = point.codePointAt(0) as number;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (used + size > budget) break;
    used += size;
    cut += point.length;
  }
  if (cut === title.length) return title;
  // The cut can expose a trailing dot or space, which Windows refuses.
  const bounded = title.slice(0, cut).replace(/[.\s]+$/, "");
  return bounded === "" ? "Untitled" : bounded;
}

/**
 * §4: unique across `wiki/`, and short enough for the host to accept.
 *
 * This is the function that turns a title into a filename, so it owns both
 * rules. Compared by handle, because the vault may sit on a case-insensitive
 * or normalization-insensitive filesystem where two spellings are one file.
 * Collisions take the §8.4 suffix idiom: `-2`, `-3`, … — and the suffix is
 * counted inside the bound, not appended past it.
 */
export function uniqueTitle(title: string, taken: ReadonlySet<string>): string {
  const bounded = boundTitle(title, MAX_TITLE_BYTES);
  if (!taken.has(handleOf(bounded))) return bounded;
  for (let suffix = 2; ; suffix++) {
    // `-<n>` is ASCII, so its byte length is its length.
    const tag = `-${suffix}`;
    const candidate = boundTitle(title, MAX_TITLE_BYTES - tag.length) + tag;
    if (!taken.has(handleOf(candidate))) return candidate;
  }
}

/** The set `uniqueTitle` expects, built from an existing table. */
export function takenTitles(pages: readonly PageMeta[]): Set<string> {
  return new Set(pages.map((page) => handleOf(page.title)));
}

/** Vault path for a page of a given kind, per §4's folder layout. */
export function pagePathForKind(title: string, kind: PageKind): string {
  const folder = kind === "source" ? "sources" : kind === "entity" ? "entities" : "concepts";
  return `${WIKI_FOLDER}/${folder}/${title}.md`;
}
