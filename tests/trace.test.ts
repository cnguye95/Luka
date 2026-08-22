// §8.3's retrieval trace. §14's minimum set names "trace write/parse
// round-trip"; §9's pane replays a trace it did not write, so recovering
// exactly what was rendered is the property that matters.
import { describe, expect, it } from "vitest";
import {
  parseTrace,
  resolveTraceNodes,
  stripTrace,
  withTrace,
  writeTrace,
  type Trace,
} from "../src/core/answer/trace";
import type { GraphSnapshot } from "../src/core/types";

// §8.3, from the spec rather than from the code under test.
const SPEC_TOP_LIMIT = 10;
const SPEC_DECIMALS = 4;

const trace = (over: Partial<Trace> = {}): Trace => ({
  mode: "B",
  seeds: ["Alpha", "Beta"],
  round2: false,
  top: [
    { label: "Xylem", score: 0.0812 },
    { label: "Yarrow", score: 0.0631 },
  ],
  ...over,
});

describe("what §8.3's example shows is what is written", () => {
  it("renders the four lines in order, inside the fences", () => {
    expect(writeTrace(trace())).toBe(
      [
        "<!-- trace:start -->",
        "## Retrieval trace",
        "- mode: B",
        "- seeds: [[Alpha]], [[Beta]]",
        "- round2: no",
        "- top: [[Xylem]] 0.0812, [[Yarrow]] 0.0631",
        "<!-- trace:end -->",
      ].join("\n"),
    );
  });

  it("writes scores to four decimals", () => {
    const rendered = writeTrace(trace({ top: [{ label: "X", score: 1 / 3 }] }));

    expect(rendered).toContain("[[X]] 0.3333");
    expect(rendered.split("0.3333")[1]?.startsWith("3")).toBe(false);
    expect(SPEC_DECIMALS).toBe(4);
  });

  it("lists at most ten top entries, however many were assembled", () => {
    // K is 12, so `top:` is deliberately shorter than the assembled set.
    const many = Array.from({ length: 12 }, (_unused, at) => ({
      label: `P${at}`,
      score: 1 / (at + 1),
    }));

    const rendered = writeTrace(trace({ top: many }));

    expect([...rendered.matchAll(/\[\[P\d+\]\]/g)]).toHaveLength(SPEC_TOP_LIMIT);
    expect(rendered).not.toContain("[[P10]]");
  });

  it("says (none) rather than leaving a line empty", () => {
    const rendered = writeTrace(trace({ seeds: [], top: [] }));

    expect(rendered).toContain("- seeds: (none)");
    expect(rendered).toContain("- top: (none)");
  });
});

describe("round trip (§14)", () => {
  it("recovers exactly what was written", () => {
    const original = trace();

    expect(parseTrace(writeTrace(original)).trace).toEqual(original);
  });

  it("recovers an empty trace", () => {
    const original = trace({ mode: "A", seeds: [], round2: true, top: [] });

    expect(parseTrace(writeTrace(original)).trace).toEqual(original);
  });

  it("round-trips a label containing brackets and a pipe", () => {
    // Titles are filenames, and `]` and `|` are legal in one on macOS and
    // Linux. The link capture is greedy for the reason `citations.ts` is.
    const original = trace({
      seeds: ["raw/[draft] notes.md"],
      top: [{ label: "raw/[draft] a|b.md", score: 0.5 }],
    });

    expect(parseTrace(writeTrace(original)).trace).toEqual(original);
  });

  it("round-trips through a whole note body", () => {
    const original = trace();
    const note = withTrace("The answer.\n", original);

    expect(parseTrace(note).trace).toEqual(original);
    expect(parseTrace(note).rest).toBe("The answer.");
  });
});

describe("the block behaves like every other sentinel block", () => {
  it("is idempotent: writing twice yields identical bytes", () => {
    const once = withTrace("Body.\n", trace());

    expect(withTrace(once, trace())).toBe(once);
  });

  it("reads the last block and strips every one", () => {
    const stale = writeTrace(trace({ mode: "A", seeds: ["Old"] }));
    const fresh = writeTrace(trace({ mode: "B", seeds: ["New"] }));
    const note = `Body.\n\n${stale}\n\n${fresh}\n`;

    const parsed = parseTrace(note);

    expect(parsed.trace?.seeds).toEqual(["New"]);
    expect(parsed.rest).toBe("Body.");
  });

  it("does not pair a stray fence in prose with the real block", () => {
    // Without the required heading, this fence would pair with the real block
    // and swallow the paragraph between them.
    const note = `Body.\n\n<!-- trace:start -->\n\nA paragraph.\n\n${writeTrace(trace())}\n`;

    const parsed = parseTrace(note);

    expect(parsed.trace?.mode).toBe("B");
    expect(parsed.rest).toContain("A paragraph.");
  });

  it("leaves a user's own fenced block alone when it has no heading", () => {
    // A filed answer note lives under `raw/` and is a user's to edit (§8.4), so
    // `parseTrace` is run over text nobody promised Luka wrote. A complete but
    // heading-less pair is not this module's block; recognizing it would strip
    // the user's prose out of their own file.
    const theirs = "<!-- trace:start -->\nMy own notes here.\n<!-- trace:end -->";
    const note = `Body.\n\n${theirs}\n`;

    const parsed = parseTrace(note);

    expect(parsed.trace).toBeNull();
    expect(parsed.rest).toContain("My own notes here.");
    expect(parsed.rest).toContain("trace:start");
  });

  it("answers null when there is no block", () => {
    expect(parseTrace("Just an answer.\n")).toEqual({ trace: null, rest: "Just an answer." });
  });

  it("strips a block whose mode it cannot read, without inventing a trace", () => {
    const damaged = [
      "<!-- trace:start -->",
      "## Retrieval trace",
      "- mode: Q",
      "<!-- trace:end -->",
    ].join("\n");

    const parsed = parseTrace(`Body.\n\n${damaged}\n`);

    // Nothing is reconstructed from it, but it is still removed — leaving it
    // would let a second block accumulate beside it.
    expect(parsed.trace).toBeNull();
    expect(parsed.rest).toBe("Body.");
  });
});

describe("§8.4's filing strips the trace and nothing else", () => {
  it("keeps the sources block", () => {
    const sources = "<!-- sources:start -->\n## Sources consulted\n- [[Alpha]]\n<!-- sources:end -->";
    const note = `The answer.\n\n${sources}\n\n${writeTrace(trace())}\n`;

    const filed = stripTrace(note);

    expect(filed).toContain("## Sources consulted");
    expect(filed).toContain("[[Alpha]]");
    expect(filed).not.toContain("Retrieval trace");
    expect(filed).not.toContain("trace:start");
  });
});

describe("resolving a trace's labels back onto graph nodes (§9's replay)", () => {
  // `labelFor` writes §4's link form — a wiki page by title, anything else by
  // path — so replay has to reverse exactly that, against whatever graph exists
  // when the pane runs rather than the one the answer saw.
  const node = (path: string, title: string, kind: "concept" | "raw") => ({
    path,
    title,
    kind,
    degree: 1,
    summary: "",
  });

  const graph: GraphSnapshot = {
    nodes: [
      node("wiki/concepts/Alpha.md", "Alpha", "concept"),
      node("wiki/concepts/Beta.md", "Beta", "concept"),
      node("wiki/concepts/Xylem.md", "Xylem", "concept"),
      node("raw/paper.md", "paper.md", "raw"),
    ],
    edges: [],
  };

  it("round-trips what writeTrace put down, wiki by title and raw by path", () => {
    const written = writeTrace(
      trace({
        seeds: ["Alpha", "Beta"],
        top: [
          { label: "Xylem", score: 0.0812 },
          { label: "raw/paper.md", score: 0.0631 },
        ],
      }),
    );
    const parsed = parseTrace(written).trace as Trace;

    const resolved = resolveTraceNodes(parsed, graph);

    expect(resolved.seeds).toEqual(["wiki/concepts/Alpha.md", "wiki/concepts/Beta.md"]);
    expect(resolved.top).toEqual([
      { path: "wiki/concepts/Xylem.md", score: 0.0812 },
      { path: "raw/paper.md", score: 0.0631 },
    ]);
    expect(resolved.unresolved).toEqual([]);
  });

  it("reports a label naming a page that has since gone, rather than dropping it", () => {
    // The ordinary case: the pane replays against the current graph, and the
    // answer may name a page a later compile deleted. Lighting fewer nodes than
    // the note lists without saying so is the failure this prevents.
    const parsed = trace({ seeds: ["Alpha", "Departed"], top: [] });

    const resolved = resolveTraceNodes(parsed, graph);

    expect(resolved.seeds).toEqual(["wiki/concepts/Alpha.md"]);
    expect(resolved.unresolved).toEqual(["Departed"]);
  });

  it("resolves a title whose case has changed since the answer was written", () => {
    // `handleOf` is §4's own normalization, so replay agrees with the identity
    // rules that decided the page's name in the first place.
    const resolved = resolveTraceNodes(trace({ seeds: ["ALPHA"], top: [] }), graph);

    expect(resolved.seeds).toEqual(["wiki/concepts/Alpha.md"]);
    expect(resolved.unresolved).toEqual([]);
  });

  it("prefers an exact node path over a title that normalizes to the same handle", () => {
    // A raw node's title is its basename, so `raw/paper.md` is both a path and
    // a title. The path is the unambiguous name and must win.
    const collide: GraphSnapshot = {
      nodes: [node("wiki/concepts/paper.md", "paper.md", "concept"), node("raw/paper.md", "paper.md", "raw")],
      edges: [],
    };

    const resolved = resolveTraceNodes(trace({ seeds: ["raw/paper.md"], top: [] }), collide);

    expect(resolved.seeds).toEqual(["raw/paper.md"]);
  });
});

describe("the trace list grammar is ambiguous, and the parser picks a side", () => {
  // Both the comma delimiter and the brackets are legal inside a label, so
  // `[[a]], [[b]]` cannot be disambiguated. These pin which way the parser
  // reads it, so a future change has to choose deliberately rather than drift.
  const bracketed = "raw/[draft] notes.md";
  const doubled = "raw/[[WIP]] paper.md";

  it("round-trips a raw path containing brackets", () => {
    // Both shapes: single brackets, and a path whose own `]]` is what a lazy
    // match would stop at. Only the second distinguishes the two readings —
    // with single brackets the first `]]` is the real terminator either way.
    const written = writeTrace(trace({ seeds: [bracketed, doubled], top: [] }));

    expect(parseTrace(written).trace?.seeds).toEqual([bracketed, doubled]);
  });

  it("round-trips a bracketed path with its score intact", () => {
    // The score is what the heat ramp draws. A parser that truncates the label
    // here also reads `3` out of `[[raw/[[Fig]] 3.md]] 0.5000` — a wrong number
    // rendered as though it were right, which is worse than a missing one.
    const written = writeTrace(trace({ seeds: [], top: [{ label: doubled, score: 0.5 }] }));

    expect(parseTrace(written).trace?.top).toEqual([{ label: doubled, score: 0.5 }]);
  });

  it("rejects a top entry that is prose rather than a list item", () => {
    // The anchors do this. Unanchored, the score regex backtracks across the
    // separator and invents a label out of any sentence containing a number.
    const hand = [
      "<!-- trace:start -->",
      "## Retrieval trace",
      "- mode: B",
      "- seeds: (none)",
      "- round2: no",
      "- top: see [[A]] 0.5000 for it",
      "<!-- trace:end -->",
    ].join("\n");

    expect(parseTrace(hand).trace?.top).toEqual([]);
  });

  it("loses a comma-bearing label, which is the accepted side of the trade", () => {
    // `,` is not forbidden in a title, so Luka can name a page `Newton, Isaac`
    // and this parser will not recover it. Recorded rather than fixed: the fix
    // is to change what `writeTrace` emits, and §8.3 fixes that shape.
    const written = writeTrace(trace({ seeds: ["Newton, Isaac"], top: [] }));

    expect(parseTrace(written).trace?.seeds).not.toContain("Newton, Isaac");
  });
});
