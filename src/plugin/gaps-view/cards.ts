// What a gap card says, as data.
//
// Core ships the cards ranked and keyed; this decides the words. The split is
// deliberate: §4's namespace rules and §10's resolution stay behind the
// boundary check, and the plugin never re-derives them — it imports types only.
// Nothing here re-sorts, either. The order is core's answer to "what should I
// add next", and a second opinion about it in the view would be a second
// ranking nobody wrote down.
//
// No DOM and no Obsidian import, so it is testable under vitest's node
// environment (`tests/fs-obsidian.test.ts` records that rule for src/plugin).
import type { GapCard, GapKind, GapReport } from "../../core/index";

/** How many citing pages the search query names before it stops helping. */
const QUERY_CITERS = 3;

export interface CardView {
  key: string;
  kind: GapKind;
  title: string;
  /** A lucide id for `setIcon`. */
  icon: string;
  /**
   * The reason, split so the number can be bold without building markup from a
   * string. §8's reading-effort rule: one bolded number per line, not prose.
   */
  reason: { before: string; number: string; after: string };
  chip: string;
  demoted: boolean;
  /** The ring labels for the glyph, in core's order. */
  ring: string[];
  /** Prefills the Ask modal, so the answer confirms or dissolves the gap. */
  askPrefill: string;
  /** A web search built from the gap and the pages that want it. No model call. */
  searchQuery: string;
}

export function toCardView(card: GapCard): CardView {
  const citerTitles = card.citers.map((citer) => citer.title);

  if (card.kind === "article") {
    return {
      key: card.key,
      kind: card.kind,
      title: card.title,
      icon: "file-plus",
      reason: {
        before: "Wanted by ",
        number: String(card.demand),
        after: ` pages that link to nothing: ${citerTitles.join(", ")}.`,
      },
      chip: `+${String(card.demand)} connections${card.demoted ? " · low confidence" : ""}`,
      demoted: card.demoted,
      ring: citerTitles,
      askPrefill: `What does the wiki say about ${card.title}?`,
      searchQuery: [card.title, ...citerTitles.slice(0, QUERY_CITERS)].join(" "),
    };
  }

  return {
    key: card.key,
    kind: card.kind,
    title: card.title,
    icon: "layers",
    reason: {
      before: "Rests on ",
      number: "1",
      after: ` source: ${card.citation ?? ""}.`,
    },
    chip: "+1 source",
    demoted: card.demoted,
    ring: citerTitles,
    askPrefill: `What else does the wiki know about ${card.title}?`,
    searchQuery: [card.title, ...citerTitles.slice(0, QUERY_CITERS)].join(" "),
  };
}

/**
 * The graph pane's filter semantics — a plain case-insensitive substring test,
 * no scoring and no call — over the names a card actually shows.
 */
export function matchesCard(card: GapCard, filter: string): boolean {
  const query = filter.trim().toLowerCase();
  if (query === "") return true;
  const haystack = [card.title, card.path ?? "", card.citation ?? "", ...card.citers.map((c) => c.title)];
  return haystack.some((text) => text.toLowerCase().includes(query));
}

export function buildCards(
  report: GapReport,
  dismissed: readonly string[],
  filter: string,
): CardView[] {
  const hidden = new Set(dismissed);
  return report.cards
    .filter((card) => !hidden.has(card.key) && matchesCard(card, filter))
    .map(toCardView);
}

/**
 * The dismissal list after dismissing one card.
 *
 * Pruned to the keys the current report still has, which is what keeps
 * `data.json` from growing forever: a key whose gap is gone — the article was
 * written, or another page started wanting it — describes nothing, and holding
 * it would suppress a card that no longer exists.
 */
export function nextDismissed(
  report: GapReport,
  dismissed: readonly string[],
  key: string,
): string[] {
  const live = new Set(report.cards.map((card) => card.key));
  const kept = dismissed.filter((entry) => entry !== key && live.has(entry));
  return [...kept, key];
}

/**
 * The status line. Counts only, and only the ones that change what the user
 * does: how many suggestions there are, how many the cap is holding back, and
 * whether anything was skipped or hidden.
 */
export function statusLine(options: {
  matched: number;
  shown: number;
  dismissed: number;
  unreadable: number;
}): string {
  const { matched, shown, dismissed, unreadable } = options;
  const parts = [`${String(matched)} suggestion${matched === 1 ? "" : "s"}`];
  if (shown < matched) parts.push(`showing ${String(shown)}`);
  if (dismissed > 0) parts.push(`${String(dismissed)} dismissed`);
  if (unreadable > 0) {
    parts.push(`${String(unreadable)} page${unreadable === 1 ? "" : "s"} could not be read`);
  }
  return parts.join(" · ");
}
