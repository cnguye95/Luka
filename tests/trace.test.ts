// §8.3's retrieval trace. §14's minimum set names "trace write/parse
// round-trip"; §9's pane replays a trace it did not write, so recovering
// exactly what was rendered is the property that matters.
import { describe, expect, it } from "vitest";
import { parseTrace, stripTrace, withTrace, writeTrace, type Trace } from "../src/core/answer/trace";

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
