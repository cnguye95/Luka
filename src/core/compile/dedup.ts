// Merge — all inventories in the run become one work-set (handoff.md §6.5).
//
// "Dedup: case-insensitive match of each item's title and aliases against the
// existing title+alias table (kind ignored). Match → that page gains this
// source as a citer and is queued for regeneration. No match → new page
// queued. Also queued: every page citing a modified/deleted source."
//
// The "existing title+alias table" is exactly M2b's `buildTitleIndex`, which is
// already case-insensitive and already resolves competing aliases
// deterministically — so this module matches through it rather than building a
// second, subtly different table.
import { comparePaths } from "../paths";
import type { PageKind, PageMeta } from "../types";
import type { InventoryItem } from "./inventory";
import { buildTitleIndex } from "./links";
import { sanitizeTitle, takenTitles, uniqueTitle } from "./pagetable";

export interface SourceInventoryEntry {
  sourcePath: string;
  items: readonly InventoryItem[];
}

/** A page that does not exist yet and will be created by this run. */
export interface NewPage {
  title: string;
  kind: PageKind;
  aliases: string[];
  summary: string;
  /** Source paths whose inventory produced this page, in encounter order. */
  citers: string[];
}

/** An existing page this run must rewrite. */
export interface RegeneratedPage {
  page: PageMeta;
  /** Sources matched to it this run; merged into the persistent citer record. */
  newCiters: string[];
  /** Aliases the model offered that the page does not already carry. */
  newAliases: string[];
  /** Latest non-empty summary offered this run; `""` keeps the existing one. */
  newSummary: string;
}

export interface WorkSet {
  newPages: NewPage[];
  regenerate: RegeneratedPage[];
}

/**
 * @param pages       the existing wiki page table
 * @param inventories one entry per successfully inventoried source
 * @param requeued    paths of pages that must regenerate for a reason other
 *                    than a match — §6.5's "every page citing a
 *                    modified/deleted source"
 * @param reserved    lowercased titles this run has already handed out but
 *                    which are not in `pages` yet — the source pages, named
 *                    before the merge so §4's "unique across `wiki/`" holds
 *                    across both halves of the run. Defaults to the titles in
 *                    `pages`.
 */
export function mergeInventories(
  pages: readonly PageMeta[],
  inventories: readonly SourceInventoryEntry[],
  requeued: readonly string[] = [],
  reserved?: ReadonlySet<string>,
): WorkSet {
  // §6.5's "kind ignored" distinguishes entity from concept — an item may match
  // a page of either. Source pages are not candidates: they are assembled by
  // code from their own file's summary and have no Call B, so matching one
  // would strand the citer on a page that never regenerates. They still hold
  // their titles, though, so a new page cannot take a filename one occupies.
  const candidates = pages.filter((page) => page.kind !== "source");
  const index = buildTitleIndex(candidates);
  const byTitle = new Map(candidates.map((page) => [page.title.toLowerCase(), page]));

  const regenerate = new Map<string, RegeneratedPage>();
  const newPages: NewPage[] = [];
  // Lowercased title-or-alias → position in `newPages`, so a second source
  // naming the same thing merges instead of creating a duplicate page.
  const newIndex = new Map<string, number>();
  // Existing titles always count; `reserved` adds the ones this run handed out
  // before the merge, so neither half can name a page the other already named.
  const claimed = takenTitles(pages);
  for (const title of reserved ?? []) claimed.add(title.toLowerCase());

  for (const path of requeued) {
    const page = pages.find((candidate) => candidate.path === path);
    if (page !== undefined) queue(regenerate, page);
  }

  // Sorted so the work-set does not depend on the order sources finished.
  const ordered = [...inventories].sort((a, b) => comparePaths(a.sourcePath, b.sourcePath));

  for (const { sourcePath, items } of ordered) {
    for (const item of items) {
      const existing = matchExisting(item, index, byTitle);
      if (existing !== undefined) {
        const entry = queue(regenerate, existing);
        if (!entry.newCiters.includes(sourcePath)) entry.newCiters.push(sourcePath);
        addAliases(entry.newAliases, item, existing.aliases, existing.title);
        if (item.summary !== "") entry.newSummary = item.summary;
        continue;
      }

      const position = matchNew(item, newIndex);
      if (position !== undefined) {
        const page = newPages[position] as NewPage;
        if (!page.citers.includes(sourcePath)) page.citers.push(sourcePath);
        // First encounter fixes title and kind; later mentions only add.
        for (const alias of aliasesOf(item)) {
          if (!hasFold(page.aliases, alias) && !equalsFold(page.title, alias)) {
            page.aliases.push(alias);
            newIndex.set(alias.toLowerCase(), position);
          }
        }
        if (item.summary !== "") page.summary = item.summary;
        continue;
      }

      // §4: the filename is the sanitized title, unique across wiki/.
      const title = uniqueTitle(sanitizeTitle(item.title), claimed);
      claimed.add(title.toLowerCase());
      const page: NewPage = {
        title,
        kind: item.kind,
        aliases: aliasesOf(item).filter((alias) => !equalsFold(title, alias)),
        summary: item.summary,
        citers: [sourcePath],
      };
      const at = newPages.length;
      newPages.push(page);
      newIndex.set(title.toLowerCase(), at);
      // The unsanitized title is also a handle: a later item saying
      // "_Mercury" must find the page created for it.
      newIndex.set(item.title.trim().toLowerCase(), at);
      for (const alias of page.aliases) newIndex.set(alias.toLowerCase(), at);
    }
  }

  return {
    newPages,
    regenerate: [...regenerate.values()].sort((a, b) => comparePaths(a.page.path, b.page.path)),
  };
}

/**
 * §6.5 matches "each item's title and aliases against the existing title+alias
 * table". Title first, then aliases in the order the model gave them, so the
 * result does not depend on Map iteration.
 *
 * The title is tried both as written and sanitized: `sanitizeTitle` is what
 * would name the new page, so a model saying "Mercury/element" must find the
 * page already called "Mercuryelement" rather than creating a twin.
 */
function matchExisting(
  item: InventoryItem,
  index: ReadonlyMap<string, string>,
  byTitle: ReadonlyMap<string, PageMeta>,
): PageMeta | undefined {
  const candidates = [item.title.trim(), sanitizeTitle(item.title), ...aliasesOf(item)];
  for (const candidate of candidates) {
    if (candidate === "") continue;
    const title = index.get(candidate.toLowerCase());
    if (title === undefined) continue;
    const page = byTitle.get(title.toLowerCase());
    if (page !== undefined) return page;
  }
  return undefined;
}

function matchNew(item: InventoryItem, newIndex: ReadonlyMap<string, number>): number | undefined {
  const candidates = [item.title.trim(), sanitizeTitle(item.title), ...aliasesOf(item)];
  for (const candidate of candidates) {
    if (candidate === "") continue;
    const at = newIndex.get(candidate.toLowerCase());
    if (at !== undefined) return at;
  }
  return undefined;
}

function queue(into: Map<string, RegeneratedPage>, page: PageMeta): RegeneratedPage {
  const existing = into.get(page.path);
  if (existing !== undefined) return existing;
  const entry: RegeneratedPage = { page, newCiters: [], newAliases: [], newSummary: "" };
  into.set(page.path, entry);
  return entry;
}

/**
 * The model's aliases for a matched page, minus the ones it already has and
 * minus its title. The item's own title counts as an alias of the page it
 * matched: "PPR" matching the page "Personalized PageRank" via an existing
 * alias means nothing new, but "Mercury" matching "Mercury (element)" through
 * an alias is worth keeping as a handle.
 */
function addAliases(
  into: string[],
  item: InventoryItem,
  existing: readonly string[],
  title: string,
): void {
  for (const alias of [item.title.trim(), ...aliasesOf(item)]) {
    if (alias === "" || equalsFold(title, alias)) continue;
    if (hasFold(existing, alias) || hasFold(into, alias)) continue;
    into.push(alias);
  }
}

function aliasesOf(item: InventoryItem): string[] {
  const out: string[] = [];
  for (const alias of item.aliases) {
    const trimmed = alias.trim();
    if (trimmed !== "" && !hasFold(out, trimmed)) out.push(trimmed);
  }
  return out;
}

function hasFold(list: readonly string[], value: string): boolean {
  return list.some((entry) => equalsFold(entry, value));
}

function equalsFold(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
