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
import type { RetrievalMode } from "../types";

const START = "<!-- trace:start -->";
const END = "<!-- trace:end -->";

const BLOCK =
  /^<!-- trace:start -->[ \t]*\r?\n## Retrieval trace[ \t]*\r?\n(?:(?!<!-- trace:(?:start|end) -->)[^\n]*\r?\n)*<!-- trace:end -->[ \t]*$/gm;

/** Greedy, so a path containing `]` round-trips — `citations.ts`'s reasoning. */
const LINK = /\[\[(.+)\]\]/;

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

function parseLinks(value: string): string[] {
  if (value === "" || value === "(none)") return [];
  const out: string[] = [];
  for (const part of value.split(",")) {
    const link = LINK.exec(part.trim());
    if (link) out.push((link[1] as string).trim());
  }
  return out;
}

function parseTop(value: string): { label: string; score: number }[] {
  if (value === "" || value === "(none)") return [];
  const out: { label: string; score: number }[] = [];
  for (const part of value.split(",")) {
    // The score sits after the closing brackets, so the link stays greedy and
    // a label containing `]` still round-trips.
    const entry = /^\[\[(.+)\]\]\s+(-?\d+(?:\.\d+)?)$/.exec(part.trim());
    if (!entry) continue;
    out.push({ label: (entry[1] as string).trim(), score: Number(entry[2]) });
  }
  return out;
}
