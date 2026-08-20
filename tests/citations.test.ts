import { describe, expect, it } from "vitest";
import {
  parseCitationBlock,
  renderCitationBlock,
  withCitationBlock,
} from "../src/core/compile/citations";

// handoff.md §4 gives the format literally; this is that sample.
const SPEC_SAMPLE = [
  "<!-- citations:start -->",
  "## Sources",
  "- [[raw/paper.md]]",
  "<!-- citations:end -->",
].join("\n");

describe("renderCitationBlock", () => {
  it("matches the §4 format byte for byte", () => {
    expect(renderCitationBlock(["raw/paper.md"])).toBe(SPEC_SAMPLE);
  });

  it("renders one line per entry, in the order given", () => {
    expect(renderCitationBlock(["raw/b.md", "raw/a.md"])).toContain(
      "- [[raw/b.md]]\n- [[raw/a.md]]",
    );
  });

  it("drops duplicates, keeping the first occurrence", () => {
    expect(renderCitationBlock(["raw/a.md", "raw/b.md", "raw/a.md"])).toBe(
      ["<!-- citations:start -->", "## Sources", "- [[raw/a.md]]", "- [[raw/b.md]]", "<!-- citations:end -->"].join("\n"),
    );
  });

  it("still renders both fences when there are no entries", () => {
    expect(renderCitationBlock([])).toBe(
      "<!-- citations:start -->\n## Sources\n<!-- citations:end -->",
    );
  });
});

describe("parseCitationBlock — the persistent citer record (§6.5)", () => {
  it("recovers exactly what render wrote", () => {
    const entries = ["raw/a.md", "raw/sub/b.pdf", "raw/answers/c.md"];
    const page = withCitationBlock("Body.", entries);
    expect(parseCitationBlock(page).entries).toEqual(entries);
  });

  it("returns the body without the block", () => {
    const parsed = parseCitationBlock(withCitationBlock("Prose here.", ["raw/a.md"]));
    expect(parsed.rest).toBe("Prose here.");
  });

  it("treats a page with no block as having no citers", () => {
    expect(parseCitationBlock("Just prose.\n")).toEqual({ entries: [], rest: "Just prose." });
  });

  it("ignores lines inside the block that are not entries", () => {
    const block = [
      "<!-- citations:start -->",
      "## Sources",
      "- [[raw/a.md]]",
      "some stray text",
      "<!-- citations:end -->",
    ].join("\n");
    expect(parseCitationBlock(block).entries).toEqual(["raw/a.md"]);
  });

  it("does not mistake a body wikilink for a citation entry", () => {
    const page = withCitationBlock("See [[Some Page]] for more.", ["raw/a.md"]);
    expect(parseCitationBlock(page).entries).toEqual(["raw/a.md"]);
  });
});

describe("withCitationBlock — idempotent regeneration (§4, §14)", () => {
  it("produces identical bytes when applied twice", () => {
    const once = withCitationBlock("Body text.", ["raw/a.md", "raw/b.md"]);
    const twice = withCitationBlock(once, ["raw/a.md", "raw/b.md"]);
    expect(twice).toBe(once);
  });

  it("replaces an existing block rather than appending a second", () => {
    const first = withCitationBlock("Body.", ["raw/old.md"]);
    const second = withCitationBlock(first, ["raw/new.md"]);
    expect(second.match(/citations:start/g)).toHaveLength(1);
    expect(second).toContain("- [[raw/new.md]]");
    expect(second).not.toContain("raw/old.md");
  });

  it("moves a mid-document block to the page foot", () => {
    const misplaced = `${renderCitationBlock(["raw/a.md"])}\n\nProse that follows.`;
    const fixed = withCitationBlock(misplaced, ["raw/a.md"]);
    expect(fixed.startsWith("Prose that follows.")).toBe(true);
    expect(fixed.trimEnd().endsWith("<!-- citations:end -->")).toBe(true);
  });

  it("puts one blank line between the body and the block", () => {
    expect(withCitationBlock("Body.", ["raw/a.md"])).toBe(
      `Body.\n\n${renderCitationBlock(["raw/a.md"])}\n`,
    );
  });

  it("handles an empty body without leading blank lines", () => {
    expect(withCitationBlock("", ["raw/a.md"])).toBe(`${renderCitationBlock(["raw/a.md"])}\n`);
  });
});

describe("shapes a real vault produces", () => {
  it("round-trips a path containing ] — a legal filename", () => {
    const citers = ["raw/paper.md", "raw/[draft] notes.md", "raw/Paper [v2].pdf"];
    expect(parseCitationBlock(withCitationBlock("Body.", citers)).entries).toEqual(citers);
  });

  it("collapses a page that somehow has two blocks down to one", () => {
    const stale = renderCitationBlock(["raw/stale.md"]);
    const body = `Intro.\n\n${stale}\n\nMiddle prose.\n\n${renderCitationBlock(["raw/old.md"])}\n`;

    const fixed = withCitationBlock(body, ["raw/truth.md"]);
    expect(fixed.match(/citations:start/g)).toHaveLength(1);
    expect(fixed).toContain("Intro.");
    expect(fixed).toContain("Middle prose.");
    // The fresh block must be what the next compile reads, not a stale one.
    expect(parseCitationBlock(fixed).entries).toEqual(["raw/truth.md"]);
    expect(withCitationBlock(fixed, ["raw/truth.md"])).toBe(fixed);
  });

  it("reads the block at the foot, not an earlier one, when both are present", () => {
    const body = `${renderCitationBlock(["raw/stale.md"])}\n\nProse.\n\n${renderCitationBlock(["raw/fresh.md"])}\n`;
    expect(parseCitationBlock(body).entries).toEqual(["raw/fresh.md"]);
  });

  it("does not let a stray start marker in prose swallow the body", () => {
    const body = "Luka emits <!-- citations:start --> then a list.\n\nSecond paragraph.";
    const written = withCitationBlock(body, ["raw/a.md"]);
    expect(written).toContain("Second paragraph.");
    expect(parseCitationBlock(written).rest).toBe(body);
  });

  it("ignores a wikilink inside the block that is not an entry line", () => {
    const block = [
      "<!-- citations:start -->",
      "## Sources",
      "- [[raw/a.md]]",
      "see also [[Some Page]]",
      "  - [[raw/b.md]] (note)",
      "<!-- citations:end -->",
    ].join("\n");
    expect(parseCitationBlock(block).entries).toEqual(["raw/a.md"]);
  });

  it("strips display text from an entry so it can match a manifest path", () => {
    const block = "<!-- citations:start -->\n## Sources\n- [[raw/a.md|The Paper]]\n<!-- citations:end -->";
    expect(parseCitationBlock(block).entries).toEqual(["raw/a.md"]);
  });

  it("drops an entry containing a newline rather than writing it unreadably", () => {
    const rendered = renderCitationBlock(["raw/ok.md", "raw/bad\nname.md"]);
    expect(parseCitationBlock(rendered).entries).toEqual(["raw/ok.md"]);
  });

  it("survives CRLF line endings", () => {
    const body = "Line one.\r\nLine two.\r\n";
    const written = withCitationBlock(body, ["raw/a.md"]);
    expect(parseCitationBlock(written).entries).toEqual(["raw/a.md"]);
    expect(withCitationBlock(written, ["raw/a.md"])).toBe(written);
  });

  it("consumes a fenced sample of the exact block shape — logged fence-blindness", () => {
    const body = "Docs:\n\n```\n" + renderCitationBlock(["raw/example.md"]) + "\n```\n\nEnd.";
    // Pinned as characterization, not endorsement: the same limitation the
    // link post-pass has, recorded in BUILD-NOTES.
    expect(parseCitationBlock(body).entries).toEqual(["raw/example.md"]);
  });
});
