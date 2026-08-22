// The retrieval trace (handoff.md §8.3), code-written into every answer note:
//
//     <!-- trace:start -->
//     ## Retrieval trace
//     - mode: B
//     - seeds: [[A]], [[B]]
//     - round2: no
//     - top: [[X]] 0.0812, [[Y]] 0.0631
//     <!-- trace:end -->
//
// §5 names `writeTrace` and `parseTrace` together, and §9's pane replays a
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

/** §8.3: "The `top:` trace line lists at most 10 entries, scores to 4 decimals." */
const TOP_LIMIT = 10;
const SCORE_DECIMALS = 4;

/** What §8.3's four lines say, in the order it writes them. */
export interface Trace {
  mode: RetrievalMode;
  /** Node paths or page titles, as they were linked. */
  seeds: string[];
  /** Whether §8.2's follow-up round ran. */
  round2: boolean;
  top: { label: string; score: number }[];
}

export interface ParsedTrace {
  trace: Trace | null;
  /** The note with every trace block removed and blank space normalized. */
  rest: string;
}

export function writeTrace(trace: Trace): string {
  const seeds = trace.seeds.map((seed) => `[[${seed}]]`).join(", ");
  const top = trace.top
    .slice(0, TOP_LIMIT)
    .map((entry) => `[[${entry.label}]] ${entry.score.toFixed(SCORE_DECIMALS)}`)
    .join(", ");
  return [
    START,
    "## Retrieval trace",
    `- mode: ${trace.mode}`,
    // An empty list renders as a word rather than as nothing, so the line keeps
    // its shape and a reader can tell "none" from "the writer forgot".
    `- seeds: ${seeds === "" ? "(none)" : seeds}`,
    `- round2: ${trace.round2 ? "yes" : "no"}`,
    `- top: ${top === "" ? "(none)" : top}`,
    END,
  ].join("\n");
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
  for (const line of authoritative[0].split("\n")) {
    const field = /^-\s*(mode|seeds|round2|top):\s*(.*)$/.exec(line.trim());
    if (field) fields.set(field[1] as string, (field[2] as string).trim());
  }

  const mode = fields.get("mode");
  // A block whose mode is missing or unrecognized is not a trace this module
  // wrote. It is still stripped — leaving it would let a second accumulate —
  // but nothing is reconstructed from it.
  if (mode !== "A" && mode !== "B") return { trace: null, rest };

  return {
    trace: {
      mode,
      seeds: parseLinks(fields.get("seeds") ?? ""),
      round2: (fields.get("round2") ?? "no") === "yes",
      top: parseTop(fields.get("top") ?? ""),
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

/** §8.4's filing: the trace goes, the sources block stays. */
export function stripTrace(text: string): string {
  return parseTrace(text).rest;
}

export interface ResolvedTrace {
  /** Node paths for the seeds the trace named, in the order it named them. */
  seeds: string[];
  /** Node paths and their recorded scores, in the order the trace listed them. */
  top: { path: string; score: number }[];
  /** Labels that name no node in this graph, in the order encountered. */
  unresolved: string[];
}

/**
 * Maps a parsed trace's labels back onto nodes of a graph (§9's replay).
 *
 * `labelFor` writes §4's link form — a wiki page by title, anything else by
 * path — so resolution reverses exactly that: an exact node path first, then a
 * title compared through `handleOf`, which is the same normalization §4's
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

  return { seeds, top, unresolved };
}

// Both lists are comma-separated, and a label may itself contain a comma:
// `,` is not in `pagetable.ts`'s FORBIDDEN set, so Luka will happily name a
// page `Newton, Isaac`. Splitting on the separator first therefore destroys
// exactly the labels a reader would most notice missing — and destroys them
// *before* `resolveTraceNodes` can count them, so §9's replay reported nothing
// unresolved while lighting fewer nodes than the note listed.
//
// Matching the brackets instead makes the comma a separator only where it is
// one. Lazy, so a label containing `]` still ends at its own `]]`.
const LINK_IN_LIST = /\[\[(.+?)\]\]/g;
const TOP_IN_LIST = /\[\[(.+?)\]\]\s+(-?\d+(?:\.\d+)?)/g;

function parseLinks(value: string): string[] {
  if (value === "" || value === "(none)") return [];
  return [...value.matchAll(LINK_IN_LIST)].map((match) => (match[1] as string).trim());
}

function parseTop(value: string): { label: string; score: number }[] {
  if (value === "" || value === "(none)") return [];
  return [...value.matchAll(TOP_IN_LIST)].map((match) => ({
    label: (match[1] as string).trim(),
    score: Number(match[2]),
  }));
}
