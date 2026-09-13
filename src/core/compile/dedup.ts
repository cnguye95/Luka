// Merge — all inventories in the run become one work-set.
//
// "Dedup: case-insensitive match of each item's title and aliases against the
// existing title+alias table (kind ignored). Match → that page gains this
// source as a citer and is queued for regeneration. No match → new page
// queued. Also queued: every page citing a modified/deleted source."
//
// The "existing title+alias table" is exactly `buildTitleTable`, which
// already folds case and Unicode form and already resolves competing aliases
// deterministically — so this module matches and assigns ownership through it
// rather than building a second, subtly different table.
import { comparePaths } from "../paths";
import type { PageKind, PageMeta } from "../types";
import type { InventoryItem } from "./inventory";
import { buildTitleTable } from "./links";
import { handleOf, sanitizeTitle, takenTitles, titleStem, uniqueTitle } from "./pagetable";

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
 *                    than a match — "every page citing a
 *                    modified/deleted source"
 * @param reserved    titles this run has already handed out but
 *                    which are not in `pages` yet — the source pages, named
 *                    before the merge so "unique across `wiki/`" holds
 *                    across both halves of the run. Defaults to the titles in
 *                    `pages`.
 */
export function mergeInventories(
  pages: readonly PageMeta[],
  inventories: readonly SourceInventoryEntry[],
  requeued: readonly string[] = [],
  reserved?: ReadonlySet<string>,
): WorkSet {
  // "Kind ignored" distinguishes entity from concept — an item may match
  // a page of either. Source pages are not candidates: they are assembled by
  // code from their own file's summary and have no Call B, so matching one
  // would strand the citer on a page that never regenerates. They still hold
  // their titles, though, so a new page cannot take a filename one occupies.
  const candidates = pages.filter((page) => page.kind !== "source");
  // Titles and aliases share one namespace and the link post-pass resolves
  // a handle to exactly one page, so an alias adopted for a second page is a
  // claim written into frontmatter that every link using it contradicts —
  // permanently, since it is re-read every compile. Resolution and ownership
  // therefore come from one table, seeded from the pages that already exist
  // and kept current as new ones are named.
  const { index, owner } = buildTitleTable(candidates);
  const byTitle = new Map(candidates.map((page) => [handleOf(page.title), page]));
  // The `-N` suffix is part of how a page was named, so it has to be part of
  // how a page is found. Titles are unique across *all* of wiki/, so a
  // concept whose name a source page already holds is named `X-2` — and
  // nothing a model returns ever spells `X-2`. Without the inverse the merge
  // creates `X-3` next compile, then `X-4`, each with its own Call B and each
  // keeping a citer so the cascade never dooms it.
  //
  // Only a base some page actually holds counts, which is the thing that
  // forced the suffix. That keeps an ordinary title like "Q3-2024" from being
  // read as "Q3" plus one.
  // `pages` *and* `reserved`, which is exactly the set the namer claims from.
  // Seeded from `pages` alone, a source page named earlier in this same run is
  // invisible to the lookup while being visible to the namer — so deleting and
  // re-adding a source leaves `X-2` and `X-3` standing for one concept, for
  // ever, each holding one citer.
  const held = new Set([
    ...pages.map((page) => handleOf(page.title)),
    ...[...(reserved ?? [])].map(handleOf),
  ]);
  const suffixed: { page: PageMeta; key: string; nth: number }[] = [];
  for (const candidate of candidates) {
    const match = /^(.*)-(\d+)$/.exec(candidate.title);
    const base = match?.[1];
    if (match === null || base === undefined || base === "") continue;
    const key = handleOf(base);
    if (index.has(key) || !held.has(key)) continue;
    suffixed.push({ page: candidate, key, nth: Number(match[2]) });
  }
  // Lowest suffix wins — the page named first, and therefore the one the
  // others were named around. Ordered explicitly rather than by arrival, for
  // the reason `buildTitleTable` sorts: a table that depends on the order
  // pages were discovered in is a table two callers can disagree about. Code
  // unit order would answer `X-10` before `X-2`.
  suffixed.sort((a, b) => a.nth - b.nth || comparePaths(a.page.path, b.page.path));
  const bySuffixBase = new Map<string, PageMeta>();
  for (const { page, key } of suffixed) if (!bySuffixBase.has(key)) bySuffixBase.set(key, page);
  const ownerOf = new Map(owner);
  // Titles already spoken for by pages this merge does not own — source pages,
  // most importantly — can never be handed out as an alias. Canonicalized
  // here rather than trusted from the caller: the guard must not depend on
  // which spelling the caller happened to hold.
  for (const title of reserved ?? []) {
    const key = handleOf(title);
    if (!ownerOf.has(key)) ownerOf.set(key, "reserved");
  }

  const regenerate = new Map<string, RegeneratedPage>();
  const newPages: NewPage[] = [];
  // Lowercased title-or-alias → position in `newPages`, so a second source
  // naming the same thing merges instead of creating a duplicate page.
  const newIndex = new Map<string, number>();
  // Existing titles always count; `reserved` adds the ones this run handed out
  // before the merge, so neither half can name a page the other already named.
  const claimed = takenTitles(pages);
  for (const title of reserved ?? []) claimed.add(handleOf(title));

  for (const path of requeued) {
    const page = pages.find((candidate) => candidate.path === path);
    if (page !== undefined) queue(regenerate, page);
  }

  // Sorted so the work-set does not depend on the order sources finished.
  const ordered = [...inventories].sort((a, b) => comparePaths(a.sourcePath, b.sourcePath));

  for (const { sourcePath, items } of ordered) {
    for (const item of items) {
      const existing = matchExisting(item, index, byTitle, bySuffixBase);
      if (existing !== undefined) {
        const entry = queue(regenerate, existing);
        if (!entry.newCiters.includes(sourcePath)) entry.newCiters.push(sourcePath);
        addAliases(entry.newAliases, item, existing.aliases, existing.title, existing.path, ownerOf);
        if (item.summary !== "") entry.newSummary = item.summary;
        continue;
      }

      const position = matchNew(item, newIndex);
      if (position !== undefined) {
        const page = newPages[position] as NewPage;
        if (!page.citers.includes(sourcePath)) page.citers.push(sourcePath);
        // First encounter fixes title and kind; later mentions only add.
        for (const alias of aliasesOf(item)) {
          const key = handleOf(alias);
          const holder = ownerOf.get(key);
          if (holder !== undefined && holder !== `new:${position}`) continue;
          if (!hasFold(page.aliases, alias) && !equalsFold(page.title, alias)) {
            page.aliases.push(alias);
            ownerOf.set(key, `new:${position}`);
            newIndex.set(key, position);
          }
        }
        if (item.summary !== "") page.summary = item.summary;
        continue;
      }

      // The filename is the sanitized title, unique across wiki/.
      const title = uniqueTitle(sanitizeTitle(item.title), claimed);
      claimed.add(handleOf(title));
      const at = newPages.length;
      const page: NewPage = {
        title,
        kind: item.kind,
        aliases: aliasesOf(item).filter(
          (alias) =>
            !equalsFold(title, alias) && !ownerOf.has(handleOf(alias)),
        ),
        summary: item.summary,
        citers: [sourcePath],
      };
      newPages.push(page);
      ownerOf.set(handleOf(title), `new:${at}`);
      for (const alias of page.aliases) ownerOf.set(handleOf(alias), `new:${at}`);
      newIndex.set(handleOf(title), at);
      // The unsanitized title is also a handle: a later item saying
      // "_Mercury" must find the page created for it.
      newIndex.set(handleOf(item.title), at);
      for (const alias of page.aliases) newIndex.set(handleOf(alias), at);
    }
  }

  return {
    newPages,
    regenerate: [...regenerate.values()].sort((a, b) => comparePaths(a.page.path, b.page.path)),
  };
}

/**
 * Matching is "each item's title and aliases against the existing title+alias
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
  bySuffixBase: ReadonlyMap<string, PageMeta>,
): PageMeta | undefined {
  // `titleStem` is the third candidate because it is the rule that *named* any
  // page already on disk: a title is stored only as a filename, so a title
  // long enough to have been cut is only findable by the cut form.
  const candidates = [
    item.title.trim(),
    sanitizeTitle(item.title),
    titleStem(item.title),
    ...aliasesOf(item),
  ];
  for (const candidate of candidates) {
    if (candidate === "") continue;
    const title = index.get(handleOf(candidate));
    if (title === undefined) continue;
    const page = byTitle.get(handleOf(title));
    if (page !== undefined) return page;
  }
  // Then the inverse of the uniqueness suffix, which is the only way to
  // reach a page whose own name no model reply will ever spell.
  for (const candidate of candidates) {
    if (candidate === "") continue;
    const page = bySuffixBase.get(handleOf(candidate));
    if (page !== undefined) return page;
  }
  return undefined;
}

function matchNew(item: InventoryItem, newIndex: ReadonlyMap<string, number>): number | undefined {
  // `titleStem` is the third candidate because it is the rule that *named* any
  // page already on disk: a title is stored only as a filename, so a title
  // long enough to have been cut is only findable by the cut form.
  // Same four candidates as `matchExisting`, so the two lookups are one rule.
  // `titleStem` is load-bearing here, not decorative: `newIndex` keys the
  // bounded title's handle and the raw title's handle but never the unbounded
  // *sanitized* one, so for a title long enough to be cut this is the only
  // candidate that can match. Two items differing only where `sanitizeTitle`
  // strips — a `#`, a doubled space — are one concept, and without it they
  // become two pages in a single run.
  const candidates = [
    item.title.trim(),
    sanitizeTitle(item.title),
    titleStem(item.title),
    ...aliasesOf(item),
  ];
  for (const candidate of candidates) {
    if (candidate === "") continue;
    const at = newIndex.get(handleOf(candidate));
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
  owner: string,
  ownerOf: Map<string, string>,
): void {
  for (const alias of [item.title.trim(), ...aliasesOf(item)]) {
    if (alias === "" || equalsFold(title, alias)) continue;
    if (hasFold(existing, alias) || hasFold(into, alias)) continue;
    // Free, or already this page's own.
    const key = handleOf(alias);
    const holder = ownerOf.get(key);
    if (holder !== undefined && holder !== owner) continue;
    ownerOf.set(key, owner);
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
  return handleOf(a) === handleOf(b);
}
