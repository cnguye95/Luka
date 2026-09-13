// Mode A's ranking, and the follow-up round's expansion.
//
// Mode A ranking: "wiki pages only; lexical score = title exact 10, alias
// exact 8, title/alias substring 4, keyword in summary 2, keyword in body 1
// (per keyword, body scan affordable because Mode A implies a small vault)."
//
// The signature takes keywords and nothing else on purpose. The follow-up
// round scores the model's `missing_information` strings with this same
// function — "lexical-score the missing-information strings (as keywords) over
// wiki pages" — and there is no question to score against there, so a scorer
// that needed one would have to be two scorers.
import { handleOf } from "../compile/pagetable";

/**
 * These are fixed, so they are module constants rather than settings.
 * The tiers are ordered: a keyword scores the highest one it reaches and only
 * that one, then the keywords are summed.
 */
const TITLE_EXACT = 10;
const ALIAS_EXACT = 8;
const SUBSTRING = 4;
const IN_SUMMARY = 2;
const IN_BODY = 1;

/** What the scorer needs of a page. `PageMeta` satisfies it structurally. */
export interface LexicalPage {
  title: string;
  aliases: readonly string[];
  summary: string;
}

export function lexicalScore(
  page: LexicalPage,
  body: string,
  keywords: readonly string[],
): number {
  const title = handleOf(page.title);
  const aliases = page.aliases.map(handleOf).filter((alias) => alias !== "");
  const summary = handleOf(page.summary);
  const text = handleOf(body);

  let score = 0;
  for (const raw of keywords) {
    const keyword = handleOf(raw);
    if (keyword === "") continue;
    score += tierOf(keyword, title, aliases, summary, text);
  }
  return score;
}

/**
 * The highest tier one keyword reaches, and only that one — the tiers are
 * alternatives, not additions, or an exact title match would also collect the
 * substring, summary and body points for being its own substring.
 */
function tierOf(
  keyword: string,
  title: string,
  aliases: readonly string[],
  summary: string,
  body: string,
): number {
  if (keyword === title) return TITLE_EXACT;
  if (aliases.includes(keyword)) return ALIAS_EXACT;
  // Either direction: "PageRank" is a substring of the query word "pageranks",
  // and the keyword "rank" is a substring of the title. The rule is "title/alias
  // substring" without naming which contains which, and both readings are the
  // same fuzzy-match intent.
  if (contains(title, keyword) || aliases.some((alias) => contains(alias, keyword))) {
    return SUBSTRING;
  }
  if (summary.includes(keyword)) return IN_SUMMARY;
  if (body.includes(keyword)) return IN_BODY;
  return 0;
}

function contains(name: string, keyword: string): boolean {
  return name.includes(keyword) || keyword.includes(name);
}
