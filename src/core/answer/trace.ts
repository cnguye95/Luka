// The retrieval trace, code-written into every answer note:
//
//     <!-- trace:start -->
//     ## Retrieval trace
//     - mode: B
//     - seeds:
//       - [[A]]
//       - [[B]]
//     - round2: no
//     - top:
//       - [[X]] 0.0812
//       - [[Y]] 0.0631
//     <!-- trace:end -->
//
// Those two lists were once inline and comma-separated. They are written one
// entry per line instead, which is a recorded deviation and the point of it:
// a comma is legal inside a title and inside a raw path, so `[[a]], [[b]]` is
// genuinely two readings and no parser over that grammar is correct. A
// newline is not legal in either — `sanitizeTitle` collapses whitespace — so
// one entry per line is a delimiter the content cannot contain. The parser
// still reads the old form, because notes written before this change exist
// and the pane replays them.
//
// `writeTrace` and `parseTrace` belong together, and the pane replays a
// trace it did not write — so parsing must recover exactly what rendering put
// down. That is `citations.ts`'s contract, and the discipline here is the same
// one: fences anchored to a line start, a required heading so a stray fence in
// prose cannot pair with the real block, the last block authoritative, and
// every block stripped so regeneration cannot accumulate them.
import { handleOf } from "../compile/pagetable";
import type { GraphSnapshot, RetrievalMode } from "../types";

const START = "<!-- trace:start -->";
const END = "<!-- trace:end -->";

const BLOCK =
  /^<!-- trace:start -->[ \t]*\r?\n## Retrieval trace[ \t]*\r?\n(?:(?!<!-- trace:(?:start|end) -->)[^\n]*\r?\n)*<!-- trace:end -->[ \t]*$/gm;

/** The `top:` trace line lists at most 10 entries, scores to 4 decimals. */
const TOP_LIMIT = 10;
const SCORE_DECIMALS = 4;

/** What the trace's four lines say, in the order they are written. */
export interface Trace {
  mode: RetrievalMode;
  /** Node paths or page titles, as they were linked. */
  seeds: string[];
  /** Whether the follow-up round ran. */
  round2: boolean;
  top: { label: string; score: number }[];
  /**
   * List entries neither list parser could read, verbatim.
   *
   * The grammar below is ambiguous, so some inputs cannot be recovered — but
   * losing them *quietly* is a different failure from losing them. Replay
   * would light fewer nodes than the note visibly lists and report nothing
   * missing, which is exactly what `resolveTraceNodes`'s `unresolved` exists to
   * prevent and could not, because these never reached it.
   *
   * `writeTrace` does not emit this; it is what parsing could not account for.
   */
  unparsed: string[];
}

export interface ParsedTrace {
  trace: Trace | null;
  /** The note with every trace block removed and blank space normalized. */
  rest: string;
}

export function writeTrace(trace: Trace): string {
  const seeds = trace.seeds.map((seed) => `[[${seed}]]`);
  const top = trace.top
    .slice(0, TOP_LIMIT)
    .map((entry) => `[[${entry.label}]] ${entry.score.toFixed(SCORE_DECIMALS)}`);
  return [
    START,
    "## Retrieval trace",
    `- mode: ${trace.mode}`,
    ...list("seeds", seeds),
    `- round2: ${trace.round2 ? "yes" : "no"}`,
    ...list("top", top),
    END,
  ].join("\n");
}

/**
 * A list field, one entry to a line.
 *
 * An empty list stays on one line as a word rather than as nothing, so the
 * field keeps its shape and a reader can tell "none" from "the writer forgot".
 */
function list(field: string, entries: readonly string[]): string[] {
  if (entries.length === 0) return [`- ${field}: (none)`];
  return [`- ${field}:`, ...entries.map((entry) => `  - ${entry}`)];
}

export function parseTrace(text: string): ParsedTrace {
  const matches = [...text.matchAll(BLOCK)];

  let rest = "";
  let cursor = 0;
  for (const match of matches) {
    rest += text.slice(cursor, match.index);
    cursor = (match.index as number) + match[0].length;
  }
  rest += text.slice(cursor);
  rest = rest.trim();

  if (matches.length === 0) return { trace: null, rest };

  const authoritative = matches[matches.length - 1] as RegExpMatchArray;
  const fields = new Map<string, string>();
  // Items of the list field currently open, for the one-per-line grammar.
  const items = new Map<string, string[]>();
  let open: string | null = null;
  for (const raw of authoritative[0].split("\n")) {
    const line = raw.replace(/\r$/, "");
    const field = /^-\s*(mode|seeds|round2|top):\s*(.*)$/.exec(line);
    if (field !== null) {
      const name = field[1] as string;
      const value = (field[2] as string).trim();
      fields.set(name, value);
      // A field with nothing after the colon opens a list; one with a value is
      // the old inline form, and closes immediately.
      open = value === "" ? name : null;
      if (open !== null) items.set(open, []);
      continue;
    }
    // Indented, so it cannot be confused with a field line or with prose that
    // happens to start with a dash.
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item !== null && open !== null) (items.get(open) as string[]).push((item[1] as string).trim());
    else if (line.trim() !== "") open = null;
  }

  const mode = fields.get("mode");
  // A block whose mode is missing or unrecognized is not a trace this module
  // wrote. It is still stripped — leaving it would let a second accumulate —
  // but nothing is reconstructed from it.
  if (mode !== "A" && mode !== "B") return { trace: null, rest };

  // One entry per line where the writer used it, and the comma split only for
  // a note written before the grammar changed.
  const seeds = readLinks(items.get("seeds"), fields.get("seeds") ?? "");
  const top = readTop(items.get("top"), fields.get("top") ?? "");
  return {
    trace: {
      mode,
      seeds: seeds.labels,
      round2: (fields.get("round2") ?? "no") === "yes",
      top: top.entries,
      unparsed: [...seeds.unparsed, ...top.unparsed],
    },
    rest,
  };
}

/**
 * Replaces any existing trace block and appends a fresh one at the foot.
 * Applying this twice with the same trace yields identical bytes.
 */
export function withTrace(text: string, trace: Trace): string {
  const { rest } = parseTrace(text);
  const block = writeTrace(trace);
  return rest === "" ? `${block}\n` : `${rest}\n\n${block}\n`;
}

/** Filing: the trace goes, the sources block stays. */
export function stripTrace(text: string): string {
  return parseTrace(text).rest;
}

export interface ResolvedTrace {
  /** Node paths for the seeds the trace named, in the order it named them. */
  seeds: string[];
  /** Node paths and their recorded scores, in the order the trace listed them. */
  top: { path: string; score: number }[];
  /**
   * What the overlay could not light: labels naming no node in this graph, in
   * the order encountered, followed by whatever the list parser could not read
   * at all (`Trace.unparsed`).
   *
   * The two have different causes and the same consequence — a page the note
   * names that the pane cannot show — so the pane reports one count.
   */
  unresolved: string[];
}

/**
 * Maps a parsed trace's labels back onto nodes of a graph (replay).
 *
 * `labelFor` writes the link form — a wiki page by title, anything else by
 * path — so resolution reverses exactly that: an exact node path first, then a
 * title compared through `handleOf`, which is the same normalization the
 * identity rules use, so a trace written before a title's case changed still
 * lands.
 *
 * A label that matches neither is *not* dropped silently. The pane replays a
 * trace against whatever graph exists now, and a page deleted since the answer
 * was written is the ordinary case; `unresolved` is what lets the pane say so
 * rather than quietly lighting fewer nodes than the note lists.
 */
export function resolveTraceNodes(trace: Trace, graph: GraphSnapshot): ResolvedTrace {
  const byPath = new Set(graph.nodes.map((node) => node.path));
  const byTitle = new Map<string, string>();
  // First claimant keeps a handle, matching `build.ts`'s own table, so two
  // pages sharing a title resolve the same way here as they do there.
  for (const node of graph.nodes) {
    const handle = handleOf(node.title);
    if (handle !== "" && !byTitle.has(handle)) byTitle.set(handle, node.path);
  }

  const unresolved: string[] = [];
  const resolve = (label: string): string | null => {
    if (byPath.has(label)) return label;
    const byHandle = byTitle.get(handleOf(label));
    if (byHandle !== undefined) return byHandle;
    unresolved.push(label);
    return null;
  };

  const seeds: string[] = [];
  for (const label of trace.seeds) {
    const path = resolve(label);
    if (path !== null) seeds.push(path);
  }

  const top: { path: string; score: number }[] = [];
  for (const entry of trace.top) {
    const path = resolve(entry.label);
    if (path !== null) top.push({ path, score: entry.score });
  }

  // Fragments the parser could not read are missing from the overlay for the
  // same reason a departed page is, and the pane owes the user the same notice.
  return { seeds, top, unresolved: [...unresolved, ...trace.unparsed] };
}

/**
 * Greedy, so a path containing `]` round-trips — `citations.ts`'s reasoning.
 *
 * These two lists are comma-separated and both the comma *and* the brackets are
 * legal inside a label: `,` is not in `pagetable.ts`'s FORBIDDEN set, and while
 * that set keeps brackets out of wiki *titles*, `labelFor` emits a raw source's
 * path verbatim, and `raw/[draft] notes.md` is a shape `citations.ts` names as
 * real. So `[[a]], [[b]]` is genuinely ambiguous — one label `a]], [[b`, or two
 * labels — and no parser over this grammar is correct for every input.
 *
 * Splitting on the comma is the reading that fails on the rarer input. It loses
 * a comma-bearing title; matching brackets lazily instead was tried and is
 * worse, because it truncates bracketed paths *and* fabricates a score for them
 * — `[[raw/[[Fig]] 3.md]] 0.5000` parsed as label `raw/[[Fig` with score 3, a
 * wrong number drawn on the heat ramp as though it were measured. Neither
 * reading is safe on a label carrying both `]]` and a comma; this one narrows
 * the corruption rather than ending it.
 *
 * Both readings also lose quietly, which is the part that *is* fixable here: an
 * earlier version of this comment claimed a lost label showed up as an
 * unresolved count, and it did not — the split destroyed it before
 * `resolveTraceNodes` could see it. `unparsed` carries those fragments through
 * so the count is honest. Recovering the label needs `writeTrace` to emit an
 * unambiguous grammar, which is a format decision, not a parser one.
 */
const LINK = /\[\[(.+)\]\]/;

/**
 * Rejoins the fragments a comma-split left behind, one entry per lost label.
 *
 * `[[Newton, Isaac]]` splits into `[[Newton` and `Isaac]]`, and `[[A, B, C]]`
 * into three — reporting those as two and three losses would overstate the
 * count in the one place that exists to make the count honest. A fragment
 * opening with `[[` starts a label; the run closes at the fragment ending in
 * `]]`, and what is between them was one label all along.
 */
function rejoin(fragments: readonly string[]): string[] {
  const out: string[] = [];
  let open: string[] = [];
  for (const fragment of fragments) {
    if (open.length === 0 && !fragment.startsWith("[[")) {
      // Not part of a split link — a stray value that was never a label.
      out.push(fragment);
      continue;
    }
    open.push(fragment);
    if (fragment.endsWith("]]")) {
      out.push(open.join(", "));
      open = [];
    }
  }
  // An unterminated run: whatever it was, it was one thing.
  if (open.length > 0) out.push(open.join(", "));
  return out;
}

/**
 * Labels from whichever grammar the note was written in.
 *
 * The line-delimited form is exact: a newline cannot occur inside a title or a
 * path this module writes, so each line is one label and nothing is lost. The
 * inline form is the ambiguous one, kept only so a note written before the
 * change still replays — with the comma reading, and the losses it counts.
 */
function readLinks(
  lines: readonly string[] | undefined,
  inline: string,
): { labels: string[]; unparsed: string[] } {
  if (lines === undefined) return parseLinks(inline);
  const labels: string[] = [];
  const unparsed: string[] = [];
  for (const line of lines) {
    const link = LINK.exec(line);
    if (link) labels.push((link[1] as string).trim());
    else unparsed.push(line);
  }
  return { labels, unparsed };
}

/** `top`'s entries, by the same rule. */
function readTop(
  lines: readonly string[] | undefined,
  inline: string,
): { entries: { label: string; score: number }[]; unparsed: string[] } {
  if (lines === undefined) return parseTop(inline);
  const entries: { label: string; score: number }[] = [];
  const unparsed: string[] = [];
  for (const line of lines) {
    const entry = TOP_ENTRY.exec(line);
    if (entry) entries.push({ label: (entry[1] as string).trim(), score: Number(entry[2]) });
    else unparsed.push(line);
  }
  return { entries, unparsed };
}

/**
 * Anchored: the score sits after the closing brackets, so the link stays
 * greedy and a label containing `]` still round-trips.
 */
const TOP_ENTRY = /^\[\[(.+)\]\]\s+(-?\d+(?:\.\d+)?)$/;

function parseLinks(value: string): { labels: string[]; unparsed: string[] } {
  if (value === "" || value === "(none)") return { labels: [], unparsed: [] };
  const labels: string[] = [];
  const fragments: string[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    const link = LINK.exec(trimmed);
    // A part that is not a whole link is a fragment of one the split cut in
    // half — the comma case. Kept so the count downstream is honest about it.
    if (link) labels.push((link[1] as string).trim());
    else if (trimmed !== "") fragments.push(trimmed);
  }
  return { labels, unparsed: rejoin(fragments) };
}

function parseTop(value: string): {
  entries: { label: string; score: number }[];
  unparsed: string[];
} {
  if (value === "" || value === "(none)") return { entries: [], unparsed: [] };
  const entries: { label: string; score: number }[] = [];
  const fragments: string[] = [];
  for (const part of value.split(",")) {
    // Anchored: the score sits after the closing brackets, so the link stays
    // greedy and a label containing `]` still round-trips. Without `^`/`$` this
    // backtracks across the separator and invents labels out of prose.
    const trimmed = part.trim();
    const entry = /^\[\[(.+)\]\]\s+(-?\d+(?:\.\d+)?)$/.exec(trimmed);
    if (entry) entries.push({ label: (entry[1] as string).trim(), score: Number(entry[2]) });
    else if (trimmed !== "") fragments.push(trimmed);
  }
  return { entries, unparsed: rejoin(fragments) };
}
