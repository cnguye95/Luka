// The answer note's `## Add next` section — what would have made this answer
// better, drawn beside the answer that lacked it.
//
// Added by decision (design_decisions.md, "Add next lives in the answer, not
// in a pane"). The first attempt was a vault-wide pane, and the thing wrong
// with it was that a vault-wide list recommends against material nobody has
// asked about. A question is a statement of what the user wants the wiki to
// know, so the gap worth naming is the one that question ran into.
//
// Two signals, both already in hand when the note is written, so the section
// costs no model call (an LLM-driven check is a non-goal, and this is the
// same rule):
//
//   - what synthesis said it was missing, which is the model reporting
//     on its own answer rather than being asked a second question about it;
//   - wikilink targets on the pages retrieved for this question that resolve
//     to nothing — an unresolved link is "a future-article signal, not
//     an error", and here the pages that wanted it are the ones the answer was
//     built from.
//
// Both are resolved by one rule — the links through `unresolvedTargets`, as
// in the health check, and synthesis's items through the same title
// index — so neither the section nor `wiki/_health.md` calls a page missing
// that the other can see.
//
// That is where the section parts company with the `missing:` frontmatter key
// it is drawn from. The key is the record: what synthesis said its answer
// lacked, verbatim, including a page that already exists. The section is the
// advice, and there is nothing to advise about a page the wiki already has.
// Two jobs, one list, different filters.
import { comparePaths } from "../paths";
import { buildTitleIndex, linkTargets } from "../compile/links";
import { handleOf, titleStem } from "../compile/pagetable";
import { unresolvedTargets, type LinkScan } from "../gaps";
import type { AssembledNode } from "../retrieve/assemble";
import type { GraphSnapshot, PageMeta } from "../types";

export const GAPS_START = "<!-- gaps:start -->";
export const GAPS_END = "<!-- gaps:end -->";

const HEADING = "## Add next";
const ANSWER_LABEL = "This answer";

/**
 * How many unresolved targets to name.
 *
 * Only the links are capped. Synthesis's items are few by nature — a model
 * reporting on one answer — and each is already filtered against the page
 * table, so what survives is worth saying. The links are a scan's output and
 * can run long on a page that gestures at everything.
 */
const TARGET_CAP = 5;

/** Mermaid label length, in code points, before an ellipsis. */
const LABEL_LIMIT = 40;

/**
 * Mirrors `trace.ts`'s block: line-anchored fences with the heading required,
 * so a fence in prose cannot pair with the real one and swallow the text
 * between them.
 */
const BLOCK =
  /^<!-- gaps:start -->[ \t]*\r?\n## Add next[ \t]*\r?\n(?:(?!<!-- gaps:(?:start|end) -->)[^\n]*\r?\n)*<!-- gaps:end -->[ \t]*$/gm;

/**
 * Characters Mermaid reads as syntax inside a quoted label, plus the brackets.
 *
 * The brackets are not Mermaid's problem — they are Luka's. `linkTargets` is
 * fence-blind, so `[[X]]` anywhere in the note is a link to the graph, and
 * Mermaid's own subroutine shape is spelled exactly that way. Escaping them
 * makes "the diagram contains no wikilink" true by construction rather than by
 * the label happening not to contain one.
 */
const MERMAID_SPECIAL = /["<>&#`[\]{}|\\%]/g;

export interface AnswerGap {
  /** The name a page would take, or synthesis's own words. */
  title: string;
  /** Named by synthesis, so drawn from the answer rather than from a page. */
  fromAnswer: boolean;
  /** Consulted pages that link to it, distinct, ordered by path. */
  citers: { path: string; title: string }[];
}

export interface AnswerGapsInput {
  /** Synthesis's missing list, already through `cleanMissing`. */
  missing: readonly string[];
  consulted: readonly AssembledNode[];
  /** The page table, so a link an alias answers is not a gap. */
  pages: readonly PageMeta[];
}

/**
 * Whether a name could become a page, by the naming rule itself.
 *
 * The namespace has two properties — how names compare and how long a name may
 * be — and `titleStem` is where both are answered: it sanitizes, which strips
 * the characters a filename cannot carry and the reserved `_` prefix, and it
 * bounds to `MAX_TITLE_BYTES`. Comparing under `handleOf` on both sides is
 * what keeps the *first* property from being tested twice: `sanitizeTitle`
 * normalizes to NFC, so a byte comparison would refuse every decomposed
 * spelling — and since the shown spelling is the `comparePaths`-minimum and
 * NFD sorts before NFC, that meant refusing accented names outright, an
 * actionable recommendation dropped for a reason that was not about the name.
 */
function nameable(name: string): boolean {
  return handleOf(titleStem(name)) === handleOf(name);
}

/**
 * A name that reads as code rather than as an article.
 *
 * Page generation invites the model to "link freely… write the natural name",
 * and on the measured vaults it obliged with `linkTargets` and `link_pairs`
 * alongside real ones.
 *
 * The test is deliberately narrow, because the cost of the two mistakes is not
 * symmetric. A code-shaped name that survives is one weak line in a list; a
 * real one that is dropped is a recommendation the user never sees, and
 * the health report goes on listing it, so the two disagree with no way to tell
 * why. An earlier version of this asked only whether a lowercase letter was
 * followed by an uppercase one, which is the shape of `linkTargets` — and of
 * `PageRank`, `OpenAI`, `GitHub` and every other capitalized compound a wiki
 * is actually about.
 *
 * So the test is two unambiguous shapes only: an underscore, and no letter at
 * all. camelCase is deliberately *not* tested. `linkTargets` and `iPhone` are
 * the same string shape, and nothing lexical tells them apart — so refusing
 * the shape means refusing real product and project names, which is the more
 * expensive of the two mistakes. A code-shaped name that survives still has to
 * be linked by a page this answer actually consulted, and still has to outrank
 * the others, so it costs at worst one weak line.
 */
function identifierShaped(name: string): boolean {
  return name.includes("_") || !/\p{L}/u.test(name);
}

/**
 * The gaps this answer ran into, synthesis's own first.
 *
 * Pure: everything it reads has already been read. The consulted nodes carry
 * the text synthesis was given, so the links it scans are the links the model
 * had in front of it — including the tail cut from an oversized first page,
 * which is the honest set rather than the complete one.
 */
export function answerGaps(input: AnswerGapsInput): AnswerGap[] {
  const scans: LinkScan[] = input.consulted
    // A raw source is a file, not a page: its links are the author's, and
    // they are not resolved against the title table.
    .filter((node) => node.kind !== "raw")
    .map((node) => ({
      page: { path: node.path, title: node.title },
      targets: linkTargets(node.text),
    }));

  // The same rule the health check resolves candidates with. Synthesis reports
  // what its answer lacked, which is not the same question as what the wiki
  // lacks: it can name a page that exists — one already among the pages it was
  // given — and the frontmatter key records that faithfully. The section is
  // advice about what to write, so a page that exists has no place in it.
  const known = buildTitleIndex(input.pages);

  const gaps: AnswerGap[] = [];
  const at = new Map<string, number>();
  for (const title of input.missing) {
    const handle = handleOf(title);
    if (known.has(handle) || at.has(handle)) continue;
    at.set(handle, gaps.length);
    gaps.push({ title, fromAnswer: true, citers: [] });
  }

  const unwritten = unresolvedTargets(input.pages, scans)
    .filter((target) => nameable(target.display) && !identifierShaped(target.display))
    .slice(0, TARGET_CAP);

  for (const target of unwritten) {
    const citers = target.citers.map((citer) => ({ path: citer.path, title: citer.title }));
    // Synthesis naming what the pages were also reaching for is one gap with
    // two kinds of evidence, not two gaps. It keeps the model's place in the
    // list and takes the pages.
    const already = at.get(target.handle);
    if (already !== undefined) {
      (gaps[already] as AnswerGap).citers = citers;
      continue;
    }
    gaps.push({ title: target.display, fromAnswer: false, citers });
  }

  return gaps;
}

/**
 * One Mermaid label, safe to write and unable to become a link.
 *
 * Truncated before escaping, so a cut never lands inside an entity and an
 * escaped character never survives past the limit as five characters where it
 * was one.
 */
export function mermaidLabel(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const points = [...flat];
  const cut = points.length > LABEL_LIMIT ? `${points.slice(0, LABEL_LIMIT).join("")}…` : flat;
  return cut.replace(MERMAID_SPECIAL, (ch) => `#${String(ch.codePointAt(0))};`);
}

/**
 * The note's third code-written block, or `""` when the answer lacked nothing.
 *
 * The diagram is a Mermaid fence, which Obsidian renders in reading view with
 * no help from the plugin — the first fenced block Luka writes into a vault.
 * It draws what a paragraph would have to describe: the gap as a dashed ghost,
 * dashed to each page that reached for it, solid between the pages that
 * already link to each other. The bullets carry the same facts in words, so a
 * reader in source mode loses the picture and none of the meaning.
 */
export function renderGapsBlock(gaps: readonly AnswerGap[], graph?: GraphSnapshot): string {
  if (gaps.length === 0) return "";

  const bullets = gaps.map((gap) => {
    if (gap.citers.length === 0) {
      return `- **${gap.title}** — the wiki could not answer this`;
    }
    // Counted by the names it then lists, which is `health.ts`'s rule for the
    // same sentence: two pages can share a filename stem, and "wanted by 2:
    // Foo, Foo" is a count the reader cannot check.
    const names = [...new Set(gap.citers.map((citer) => citer.title))];
    return `- **${gap.title}** — wanted by ${String(names.length)} of the pages consulted: ${names.join(", ")}`;
  });

  return [GAPS_START, HEADING, ...bullets, "", "```mermaid", ...diagram(gaps, graph), "```", GAPS_END].join(
    "\n",
  );
}

function diagram(gaps: readonly AnswerGap[], graph?: GraphSnapshot): string[] {
  // Every page any gap wants, once, in path order — so the ids do not depend
  // on which gap named a page first.
  const paths = [...new Set(gaps.flatMap((gap) => gap.citers.map((citer) => citer.path)))].sort(
    comparePaths,
  );
  const titles = new Map<string, string>();
  for (const gap of gaps) {
    for (const citer of gap.citers) if (!titles.has(citer.path)) titles.set(citer.path, citer.title);
  }
  const idOf = new Map(paths.map((path, index) => [path, `p${String(index)}`]));
  const fromAnswer = gaps.some((gap) => gap.fromAnswer);

  const lines = ["graph LR"];
  // A stadium, so the thing being explained does not look like another page.
  if (fromAnswer) lines.push(`  a(["${ANSWER_LABEL}"])`);
  for (const path of paths) {
    lines.push(`  ${idOf.get(path) as string}["${mermaidLabel(titles.get(path) as string)}"]`);
  }
  gaps.forEach((gap, index) => {
    lines.push(`  g${String(index)}["${mermaidLabel(gap.title)}"]:::gap`);
  });

  gaps.forEach((gap, index) => {
    if (gap.fromAnswer) lines.push(`  a -.- g${String(index)}`);
    for (const citer of gap.citers) {
      lines.push(`  ${idOf.get(citer.path) as string} -.- g${String(index)}`);
    }
  });

  // What the wiki already holds, so the dashes read as the addition to it.
  for (const edge of graph?.edges ?? []) {
    const a = idOf.get(edge.a);
    const b = idOf.get(edge.b);
    if (a !== undefined && b !== undefined) lines.push(`  ${a} --- ${b}`);
  }

  // Space-separated: a comma inside a `classDef` value would need escaping.
  lines.push("  classDef gap stroke-dasharray:5 5,fill:none");
  return lines;
}

/**
 * Filing strips this with the trace.
 *
 * The section names pages that do not exist. Kept, the next compile's
 * inventory would read those names as things the source says are true, and the
 * wiki would grow a page from a recommendation to write one. The `missing:`
 * frontmatter key survives filing and is the durable form of the same signal.
 */
export function stripGaps(text: string): string {
  const matches = [...text.matchAll(BLOCK)];
  let rest = "";
  let cursor = 0;
  for (const match of matches) {
    rest += text.slice(cursor, match.index);
    cursor = (match.index as number) + match[0].length;
  }
  rest += text.slice(cursor);
  return rest.trim();
}
