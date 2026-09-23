// Call B — page generation, plus the code-written half of every page
// (invariant 5).
//
// The input is title, kind, aliases, and the full normalized bodies of *all*
// citing sources (token-budgeted using the same context-budget default as
// retrieval, whole sources in citation order, truncation marker if the budget
// forces it); never the old page text. The citation block is the persistent
// citer record: a page's citing set = surviving entries of its existing block
// ∪ this run's inventory matches; the block is rewritten from that set
// afterward. The output is the page body prose with [[wikilinks]].
import type { FsAdapter } from "../adapters";
import { decodeUtf8 } from "../hash";
import { sourceWithoutContent, truncatedForContextBudget } from "../markers";
import { readableMarkdown } from "../readable";
import { isPassthrough } from "../normalize/index";
import type { LLMProvider } from "../provider/types";
import { packUnderBudget } from "../tokens";
import type { PageKind, PageMeta, SourceFormat } from "../types";
import { serializeFrontmatter } from "../yaml";
import { parseCitationBlock, withCitationBlock } from "./citations";
import type { TitleIndex } from "./links";
import { resolveLinks } from "./links";
import { handleOf } from "./pagetable";
import { pagePathForKind } from "./pagetable";

const SYSTEM = [
  "You are the page-writing step of a personal knowledge wiki compiler.",
  "You are given a page title, its kind, its aliases, and the full text of every",
  "source that cites this page. Write the body of that page.",
  "",
  "Rules:",
  "- Write prose in markdown. Explain the subject as the sources describe it.",
  "- Link freely to the other concepts and entities you name, as [[wikilinks]].",
  "  Write the natural name inside the brackets; a later pass resolves it.",
  "- Do NOT write citations, a sources list, frontmatter, or a heading that",
  "  repeats the title. Those are written by code and yours would be discarded.",
  "- Ground every claim in the provided sources. Say nothing they do not support.",
].join("\n");

/** A source as Call B and the citation block see it. */
export interface CitingSource {
  /** The source's own vault path — its manifest identity and citation target. */
  path: string;
  /** Text of its readable markdown (itself, or its derivative). */
  body: string;
}

export interface GeneratePageInput {
  title: string;
  kind: PageKind;
  aliases: readonly string[];
  /** In citation order; the assembly budget consumes them in this order. */
  sources: readonly CitingSource[];
  contextBudgetTokens: number;
}

/** Runs Call B and returns the model's prose, unmodified. */
export async function generatePageBody(
  provider: LLMProvider,
  input: GeneratePageInput,
): Promise<string> {
  const reply = await provider.complete({
    task: "page-generation",
    system: SYSTEM,
    user: renderCallBPrompt(input),
  });
  const body = reply.trim();

  // The prompt already tells the model which sources the budget dropped. The
  // page has to say so too: code writes the citation block from the full citer
  // set, so without this the page claims a source it was never grounded in —
  // and that block is the persistent citer record, so the false claim
  // outlives the run and feeds the graph.
  const { overBudget, empty } = shortfall(input);
  const notes = [
    ...(overBudget.length === 0 ? [] : [truncatedForContextBudget(overBudget)]),
    ...(empty.length === 0 ? [] : [sourceWithoutContent(empty)]),
  ];
  return notes.length === 0 ? body : `${body}\n\n${notes.join("\n")}`;
}

/**
 * The citing sources the model did not receive in full, split by cause.
 *
 * Two classes are over budget. A source the budget could not fit at all is
 * obvious; a source that was *truncated* is not, because packing truncates the
 * first item rather than dropping it, so it stays in `items` while the model
 * saw only part of it — and at a small enough budget, none of it. Naming only
 * what was dropped implies the rest arrived whole.
 *
 * A source that fitted but has no body is a different problem with the same
 * consequence, and it gets its own marker: the budget marker's wording is
 * fixed, and an empty file under a 40,000-token budget was neither
 * truncated nor over budget.
 */
function shortfall(input: GeneratePageInput): { overBudget: string[]; empty: string[] } {
  const head = renderHead(input);
  const packed = packUnderBudget(
    input.sources,
    (source) => renderSource(source),
    Math.max(0, input.contextBudgetTokens - estimateHead(head)),
  );
  const overBudget = input.sources.slice(packed.items.length).map((source) => source.path);
  if (packed.truncated && packed.items.length > 0) {
    const cut = input.sources[packed.items.length - 1];
    if (cut !== undefined) overBudget.unshift(cut.path);
  }
  const empty = input.sources
    .filter((source) => source.body.trim() === "" && !overBudget.includes(source.path))
    .map((source) => source.path);
  return { overBudget, empty };
}

/**
 * The user message: the page's identity, then whole sources in citation order
 * under the context budget. Exported so a test can assert what the model is
 * and is not shown — notably that the old page text never appears.
 */
export function renderCallBPrompt(input: GeneratePageInput): string {
  const head = renderHead(input);

  const packed = packUnderBudget(
    input.sources,
    (source) => renderSource(source),
    Math.max(0, input.contextBudgetTokens - estimateHead(head)),
  );

  const parts: string[] = [head, ...packed.texts];
  // The input is the full normalized bodies of *all* citing sources, with a
  // truncation marker if the budget forces a cut. A source the budget dropped
  // whole is the budget forcing it just as much as a tail cut is: without the
  // marker the model writes a page grounded in a subset of its sources while
  // code afterwards writes a citation block claiming all of them.
  if (packed.items.length < input.sources.length) {
    const dropped = input.sources.slice(packed.items.length).map((source) => source.path);
    parts.push(`${truncatedForContextBudget()}\nOmitted for budget: ${dropped.join(", ")}`);
  }

  return parts.join("\n\n");
}

/** Title, kind and aliases — the part of the prompt that is not source text. */
function renderHead(input: GeneratePageInput): string {
  return [
    `Title: ${input.title}`,
    `Kind: ${input.kind}`,
    `Aliases: ${input.aliases.length === 0 ? "(none)" : input.aliases.join(", ")}`,
  ].join("\n");
}

function renderSource(source: CitingSource): string {
  return `--- source: ${source.path} ---\n${source.body}`;
}

function estimateHead(head: string): number {
  // The delimiters and the head are part of the budget; a rough allowance keeps
  // the assembled prompt under it without a second packing pass.
  return Math.ceil((head.length + 64) / 4);
}

/**
 * The persistent citer record: surviving entries of the existing block,
 * then this run's matches. Order is the citation order Call B assembles in,
 * so a page's oldest sources stay first and the prompt is stable between runs.
 *
 * "Surviving" is decided by `isLive` — the caller passes the next manifest's
 * membership, so a deleted source drops out of every block that cited it.
 */
export function citerUnion(
  existing: readonly string[],
  added: readonly string[],
  isLive: (path: string) => boolean,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of [...existing, ...added]) {
    if (seen.has(path) || !isLive(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/** The existing citer record of every page, read from its citation block. */
export async function readCitations(
  fs: FsAdapter,
  pages: readonly PageMeta[],
): Promise<Map<string, string[]>> {
  const citations = new Map<string, string[]>();
  for (const page of pages) {
    const text = decodeUtf8(await fs.read(page.path));
    citations.set(page.path, parseCitationBlock(text).entries);
  }
  return citations;
}

export interface PageToWrite {
  path: string;
  title: string;
  kind: PageKind;
  aliases: string[];
  summary: string;
  /** Model prose (entity/concept) or Call A's source_summary (source pages). */
  body: string;
  /** Citation targets, already unioned and ordered. */
  citers: string[];
  /** Source pages only: the `source: "[[raw/<file>]]"` frontmatter key. */
  sourcePath?: string;
}

/**
 * The whole page, bytes exact: code writes frontmatter, resolves the model's
 * links, and appends the citation block (invariant 5). `wiki/` is
 * machine-owned, so this is a wholesale rewrite (invariant 7).
 */
export function renderPage(page: PageToWrite, index: TitleIndex, updated: string): string {
  const frontmatter = serializeFrontmatter({
    kind: page.kind,
    aliases: page.aliases,
    summary: page.summary,
    updated,
    ...(page.sourcePath === undefined ? {} : { source: `[[${page.sourcePath}]]` }),
  });
  const body = withCitationBlock(
    resolveLinks(withoutTitleHeading(page.body, page.title), index),
    page.citers,
  );
  return frontmatter + body;
}

/**
 * The post-process has a fifth pass: a leading heading that only repeats
 * the page's own title comes off.
 *
 * The prompt already forbids one, and told the model "yours would be
 * discarded", which was not true of anything — no pass stripped it, so the
 * sentence was a promise the code did not keep. The manual checklist found the
 * page where the model did not comply, one in twenty-nine. Invariant 5 is that
 * code writes the structure and the model writes prose; a heading is
 * structure, and leaving the only defense in a prompt makes the invariant hold
 * as far as the model feels like it.
 *
 * Only the *leading* heading, and only when it matches. `## How the update
 * works` further down is prose the page needs, and a first heading that says
 * something else is the model organizing its own text — which it is meant to
 * do. Matching uses `handleOf`, so the same fold names are compared by catches
 * a heading differing only in case or Unicode form.
 */
export function withoutTitleHeading(body: string, title: string): string {
  const match = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*(?:\r?\n|$)/.exec(body.trimStart());
  if (match === null) return body;
  if (handleOf(match[1] as string) !== handleOf(title)) return body;
  return body.trimStart().slice(match[0].length).trimStart();
}

/**
 * The readable-markdown rule, from a normalize outcome rather than a manifest
 * entry: `readable.ts` owns what the rule says, and this owns the translation.
 *
 * Non-null where `readableMarkdown` can be null, and the difference is the
 * input, not the rule. This runs immediately after a normalize that reported
 * success, so a converting source has its derivative in hand — the case the
 * shared rule refuses is one this caller cannot be in. Falling back to the
 * source path preserves the behaviour every caller here already depends on;
 * `readable.ts` is the place to look for what happens when the pointer really
 * is missing.
 */
export function readablePathFor(
  sourcePath: string,
  format: SourceFormat,
  derivativePath: string | null,
): string {
  if (isPassthrough(format)) return sourcePath;
  return readableMarkdown(sourcePath, derivativePath ?? undefined, false) ?? sourcePath;
}

/** The vault path a page of this kind and title occupies. */
export { pagePathForKind };
