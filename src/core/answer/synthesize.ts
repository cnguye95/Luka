// Synthesis and the answer note (handoff.md §8.2, §8.3).
//
// §8.2: "Input: question + assembled pages, each delimited and labeled with
// their title/path/kind. Prompt requirements: answer in markdown; attribute
// claims with inline `[[links]]` drawn only from the provided set; end with
// exactly one fenced JSON block `{"missing_information": [...]}` (empty list
// when done). Code strips the block."
//
// Invariant 5 governs the note this module renders: "Citation blocks,
// frontmatter, footers, and the index are written by code, never by the model.
// The model writes prose only." Everything below the answer text — the
// frontmatter, the callout, the sources block, the trace — is code's.
import { handleOf } from "../compile/pagetable";
import { buildTitleIndex } from "../compile/links";
import { linkOutsideRetrievedSet } from "../markers";
import { comparePaths } from "../paths";
import { serializeFrontmatter } from "../yaml";
import type { LLMProvider } from "../provider/types";
import type { PageMeta, RetrievalMode } from "../types";
import type { AssembledNode } from "../retrieve/assemble";
import { writeTrace, type Trace } from "./trace";

const SOURCES_START = "<!-- sources:start -->";
const SOURCES_END = "<!-- sources:end -->";

/** §8.3's exact wording for the ungrounded case. */
const UNGROUNDED_CALLOUT = "> [!warning] Not grounded in your wiki";

/** §8.3: "slug: lowercase, alphanumerics and dashes, max 60 chars". */
const SLUG_LIMIT = 60;

const SYSTEM = [
  "You answer a question from the wiki pages you are given, and nothing else.",
  "- Answer in markdown prose.",
  "- Attribute claims with inline [[links]], drawn only from the pages provided.",
  "  Never link to a page that is not in the set you were given.",
  "- Do not write frontmatter, headings for sources, or a citation list. Code writes those.",
  "- End with exactly one fenced JSON block:",
  '  ```json',
  '  {"missing_information": []}',
  '  ```',
  "  List what the given pages could not answer; an empty list means they sufficed.",
].join("\n");

export interface SynthesisReply {
  /** The model's prose, with the trailing JSON block removed. */
  body: string;
  missing: string[];
}

export function renderSynthesisPrompt(question: string, nodes: readonly AssembledNode[]): string {
  const parts = [`Question: ${question}`, ""];
  for (const node of nodes) {
    // Delimited and labeled per §8.2, so the model can attribute a claim to the
    // page it came from and link to it by the title code will accept back.
    parts.push(`--- page: ${node.title} (${node.kind}, ${node.path}) ---`, node.text, "");
  }
  if (nodes.length === 0) {
    parts.push("(No wiki pages were retrieved. Answer from your own knowledge.)", "");
  }
  return parts.join("\n");
}

export async function synthesize(
  provider: LLMProvider,
  question: string,
  nodes: readonly AssembledNode[],
): Promise<SynthesisReply> {
  // Prose, not JSON mode: §8.2's reply is markdown that happens to end with a
  // fenced block, and asking the wrapper to parse the whole thing as JSON would
  // reject every valid answer. Temperature is left unset, as page generation
  // leaves it — §11 fixes temperature 0 for JSON tasks only.
  const reply = await provider.complete({
    task: "synthesis",
    system: SYSTEM,
    user: renderSynthesisPrompt(question, nodes),
  });
  return stripMissingBlock(reply);
}

/**
 * Removes §8.2's trailing fenced JSON block and reads its list.
 *
 * Only a block at the very end is taken: a fenced example in the middle of an
 * answer is prose the user asked for. A block that is missing, unparseable, or
 * not the documented shape reads as an empty list — the answer itself is sound
 * either way, and failing the whole query over a malformed footer would throw
 * away work already paid for.
 */
export function stripMissingBlock(reply: string): SynthesisReply {
  const text = reply.trimEnd();
  // The content may not itself contain a fence. Without that, a lazy match
  // still backtracks across an earlier code block and swallows every word
  // between it and the footer — an answer that opens with an example loses its
  // whole body.
  const fence = /\n?```(?:json)?[ \t]*\r?\n((?:(?!```)[\s\S])*?)\r?\n?```[ \t]*$/.exec(text);
  if (fence === null) return { body: text.trim(), missing: [] };

  const body = text.slice(0, fence.index).trim();
  let missing: string[] = [];
  try {
    const parsed = JSON.parse(fence[1] as string) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const list = (parsed as Record<string, unknown>)["missing_information"];
      if (Array.isArray(list)) {
        missing = list.filter((item): item is string => typeof item === "string" && item.trim() !== "");
      }
    }
  } catch {
    // Not JSON. The block is still the model's footer, so it comes off.
  }
  return { body, missing };
}

/**
 * §8.3: "any link outside the retrieved set is unlinked to plain text plus
 * marker".
 *
 * The link becomes the text it displayed, so the sentence still reads, and the
 * marker names what was dropped. A page that was retrieved keeps its link.
 */
export function validateAnswerLinks(
  body: string,
  retrieved: readonly AssembledNode[],
  pages: readonly PageMeta[] = [],
): string {
  const retrievedPaths = new Set(retrieved.map((node) => node.path));
  const known = new Set<string>();
  for (const node of retrieved) {
    known.add(handleOf(node.title));
    known.add(handleOf(node.path));
  }

  // An alias of a retrieved page is not a link outside the retrieved set. §4
  // gives titles and aliases one namespace and resolves a handle through the
  // title table, so resolution here goes through that same table rather than
  // matching titles alone — otherwise a model that writes `[[PPR]]` for a page
  // retrieved as "Personalized PageRank" has its link stripped for naming the
  // right page by its other name.
  const index = buildTitleIndex(pages);
  const pathByTitle = new Map(pages.map((page) => [handleOf(page.title), page.path]));

  return body.replace(/\[\[([^\]\n]+)\]\]/g, (full, inner: string) => {
    const pipe = inner.indexOf("|");
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    // A piped link with nothing after the pipe still has to leave a readable
    // sentence: §8.3 unlinks "to plain text", and an empty display would put a
    // bare marker where a word used to be.
    const piped = pipe === -1 ? "" : inner.slice(pipe + 1).trim();
    const display = piped === "" ? target : piped;
    if (target === "" || known.has(handleOf(target))) return full;

    // A heading or block reference addresses a place *inside* a page, which is
    // the guard `links.ts` states in those words. Judged on the page it points
    // into: unlinking `[[PageRank#Details]]` when PageRank was retrieved both
    // destroys a correct citation and attaches a marker that is untrue.
    const hash = target.search(/[#^]/);
    const page = hash === -1 ? target : target.slice(0, hash);
    // `[[#Heading]]` and `[[^block]]` name no page at all — they address a
    // place inside *this* note. Unlinking one destroys a working reference and
    // attaches a marker asserting something untrue: it was never outside any
    // retrieved set, because it never pointed outside this note. `build.ts`'s
    // `resolve()` already treats every `#`/`^` target as not-a-page, so leaving
    // it linked contributes no edge either.
    if (page === "") return full;
    if (known.has(handleOf(page))) return full;

    const canonical = index.get(handleOf(page));
    const resolved = canonical === undefined ? undefined : pathByTitle.get(handleOf(canonical));
    if (resolved !== undefined && retrievedPaths.has(resolved)) return full;

    return `${display} ${linkOutsideRetrievedSet(target)}`;
  });
}

/**
 * Every sentinel code owns in an answer note. A model reply containing one is
 * forging a structure invariant 5 reserves for code.
 */
const CODE_OWNED_SENTINEL =
  /^[ \t]*<!--[ \t]*(?:sources|trace):(?:start|end)[ \t]*-->[ \t]*\r?\n?/gm;

/**
 * Removes code-owned sentinels from the model's prose.
 *
 * Invariant 5 gives code the citation blocks, the frontmatter and the footers.
 * The harm is a *parse* harm, not a link harm: a reply that emits
 * `<!-- trace:start -->` puts a second parseable block in front of `parseTrace`,
 * which treats the last match as authoritative and deletes the span of every
 * match — so a forgery silently eats whatever sits between it and code's real
 * block. An unterminated one is worse still, since §8.4's filing cannot pair it.
 *
 * It is *not* true that a forged block's links become graph edges §7.1 would
 * not otherwise have. `validateAnswerLinks` runs over the whole body first, so
 * a forged link to a page outside the retrieved set is already unlinked, and a
 * forged link to one inside it names a page code's own sources block lists
 * anyway — §7.1 dedupes per pair, so the edge set is identical either way. An
 * earlier version of this comment claimed otherwise; measured, it is not so.
 *
 * Deliberately blind to code fences, because every consumer downstream is.
 * `parseTrace` and `linkTargets` both scan the whole file with a plain regex,
 * so a sentinel quoted inside a fence is structure to them regardless. Sparing
 * it here would not preserve the quote: it would hand `stripTrace` a block to
 * remove at filing time, which empties the fence entirely instead of docking
 * two lines from it. The example loses its delimiters, which is the honest cost
 * of the parsers being fence-blind — and the cheaper of the two losses.
 *
 * Only the sentinel lines go, each with its own newline so no blank is left
 * where one stood. What the model wrote around them is prose, and §4 says the
 * model writes prose — a heading it chose is its own. What it may not do is
 * produce something that parses as a block code is supposed to own.
 */
function withoutForgedBlocks(body: string): string {
  return body.replace(CODE_OWNED_SENTINEL, "");
}

export interface AnswerNote {
  question: string;
  /** ISO datetime, §4's `asked`. */
  asked: string;
  mode: RetrievalMode;
  grounded: boolean;
  /** The model's prose, already stripped of its JSON block. */
  body: string;
  consulted: readonly AssembledNode[];
  /** The page table, so an alias of a retrieved page still resolves (§4). */
  pages?: readonly PageMeta[];
  trace: Trace;
}

/**
 * The whole note, as one string. Invariant 11 wants it written atomically, and
 * the simplest way to keep that promise is to have nothing to write until
 * everything is decided.
 */
export function renderAnswerNote(note: AnswerNote): string {
  const frontmatter = serializeFrontmatter({
    kind: "answer",
    question: note.question,
    asked: note.asked,
    mode: note.mode,
    grounded: note.grounded,
  });

  const parts: string[] = [];
  // §8.3 puts the callout first, before the answer.
  if (!note.grounded) parts.push(UNGROUNDED_CALLOUT, "");
  parts.push(
    withoutForgedBlocks(validateAnswerLinks(note.body, note.consulted, note.pages ?? [])).trim(),
    "",
  );
  parts.push(renderSourcesBlock(note.consulted), "");
  parts.push(writeTrace(note.trace));

  return `${frontmatter}${parts.join("\n")}\n`;
}

/** §8.3's `## Sources consulted` block — a different block from §4's citations. */
export function renderSourcesBlock(consulted: readonly AssembledNode[]): string {
  const lines = [SOURCES_START, "## Sources consulted"];
  // Sorted by path, so two answers over the same set list it the same way.
  for (const node of [...consulted].sort((a, b) => comparePaths(a.path, b.path))) {
    // A wiki page is named by its title, a raw source by its path — §4's rule
    // for which form a link takes.
    lines.push(`- [[${node.kind === "raw" ? node.path : node.title}]]`);
  }
  lines.push(SOURCES_END);
  return lines.join("\n");
}

/**
 * §8.3's path: `answers/YYYY-MM-DD-HHmm <question-slug>.md`.
 *
 * UTC, matching `ingested`'s convention: a vault synced between machines in
 * different zones would otherwise name two notes by the same local minute.
 */
export function answerNotePath(question: string, now: Date): string {
  const stamp = [
    now.getUTCFullYear(),
    "-",
    two(now.getUTCMonth() + 1),
    "-",
    two(now.getUTCDate()),
    "-",
    two(now.getUTCHours()),
    two(now.getUTCMinutes()),
  ].join("");
  return `answers/${stamp} ${slugOf(question)}.md`;
}

export function slugOf(question: string): string {
  const slug = question
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_LIMIT)
    .replace(/-+$/, "");
  // A question written entirely in a non-Latin script slugs to nothing. The
  // timestamp already makes the name unique, so the slug only has to be a
  // legal, non-empty filename component.
  return slug === "" ? "answer" : slug;
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}
