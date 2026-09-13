// Context-budget arithmetic (the default budget is 40,000 tokens, counted as
// chars/4). Shared by generation's citing-source assembly and
// retrieval's top-K assembly, so both obey one definition of "fits".
import { truncatedForContextBudget } from "./markers";

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface Truncated {
  text: string;
  truncated: boolean;
}

/**
 * Tail-truncates so the result — marker included — fits within `maxTokens`.
 * The cut never lands between the halves of a surrogate pair.
 *
 * One exception: a budget too small to hold the marker at all yields the bare
 * marker, which is over budget. Signalling the truncation is worth more than
 * the handful of tokens, and callers must not treat the result as a guarantee
 * at very small budgets.
 */
export function truncateToTokens(text: string, maxTokens: number): Truncated {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };

  const suffix = `\n${truncatedForContextBudget()}`;
  const room = maxTokens * CHARS_PER_TOKEN - suffix.length;
  // Budget too small to hold anything alongside the marker.
  if (room <= 0) return { text: truncatedForContextBudget(), truncated: true };

  let cut = room;
  if (isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
  return { text: text.slice(0, cut).replace(/\s+$/, "") + suffix, truncated: true };
}

export interface Packed<T> {
  items: T[];
  /** Parallel to `items`; the last may be truncated. */
  texts: string[];
  truncated: boolean;
  usedTokens: number;
}

/**
 * Takes whole items in the order given until one does not fit, then stops —
 * it never skips a large item to pull a later small one forward, because
 * both callers assemble in a meaningful order (citation order, rank
 * order) that cherry-picking would destroy.
 *
 * Never split a page; a single page over the whole budget is tail-truncated
 * with the marker — so the first item is truncated rather
 * than dropped, which is the only way a budget smaller than one page still
 * yields context.
 *
 * That exception is for the *whole* budget. A caller packing into what is
 * left of one — the follow-up round, which appends "under the remaining
 * context budget" — passes `truncateFirst: false`, and a first item that does
 * not fit is dropped like any other: a remnant that holds no page whole yields
 * nothing, rather than a fragment a model call would then be spent on.
 */
export function packUnderBudget<T>(
  items: readonly T[],
  getText: (item: T) => string,
  budgetTokens: number,
  maxItems?: number,
  truncateFirst = true,
): Packed<T> {
  const limit = maxItems === undefined ? items.length : Math.max(0, maxItems);
  const chosen: T[] = [];
  const texts: string[] = [];
  let usedTokens = 0;
  let truncated = false;

  for (const item of items.slice(0, limit)) {
    const text = getText(item);
    const cost = estimateTokens(text);

    if (usedTokens + cost <= budgetTokens) {
      chosen.push(item);
      texts.push(text);
      usedTokens += cost;
      continue;
    }

    if (chosen.length === 0 && truncateFirst) {
      const cut = truncateToTokens(text, budgetTokens);
      chosen.push(item);
      texts.push(cut.text);
      usedTokens = estimateTokens(cut.text);
      truncated = cut.truncated;
    }
    break;
  }

  return { items: chosen, texts, truncated, usedTokens };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
