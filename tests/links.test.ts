import { describe, expect, it } from "vitest";
import { buildTitleIndex, linkTargets, resolveLinks } from "../src/core/compile/links";
import type { PageMeta } from "../src/core/types";

function page(title: string, aliases: string[] = [], kind: PageMeta["kind"] = "concept"): PageMeta {
  return { path: `wiki/${title}.md`, title, kind, aliases, summary: "", updated: "2026-08-20" };
}

const PAGES = [
  page("Personalized PageRank", ["PPR", "personalised pagerank"]),
  page("Mercury (element)", ["quicksilver"]),
  page("Obsidian"),
];
const INDEX = buildTitleIndex(PAGES);

describe("buildTitleIndex", () => {
  it("maps titles and aliases case-insensitively to the canonical title", () => {
    expect(INDEX.get("personalized pagerank")).toBe("Personalized PageRank");
    expect(INDEX.get("ppr")).toBe("Personalized PageRank");
    expect(INDEX.get("quicksilver")).toBe("Mercury (element)");
  });

  it("lets a page's own title outrank another page's alias for the same string", () => {
    const index = buildTitleIndex([page("Mercury"), page("Planets", ["Mercury"])]);
    expect(index.get("mercury")).toBe("Mercury");
  });

  it("resolves competing aliases deterministically, independent of input order", () => {
    const a = buildTitleIndex([page("Beta", ["shared"]), page("Alpha", ["shared"])]);
    const b = buildTitleIndex([page("Alpha", ["shared"]), page("Beta", ["shared"])]);
    expect(a.get("shared")).toBe(b.get("shared"));
    expect(a.get("shared")).toBe("Alpha");
  });

  it("ignores blank aliases", () => {
    expect(buildTitleIndex([page("Thing", ["", "  "])]).size).toBe(1);
  });
});

describe("resolveLinks (§4, §14)", () => {
  it("rewrites an alias to [[Title|Alias]]", () => {
    expect(resolveLinks("We rank with [[PPR]] here.", INDEX)).toBe(
      "We rank with [[Personalized PageRank|PPR]] here.",
    );
  });

  it("leaves an exact title alone rather than adding a redundant pipe", () => {
    const body = "See [[Personalized PageRank]].";
    expect(resolveLinks(body, INDEX)).toBe(body);
  });

  it("pipes a case variant of a title so the link resolves in Obsidian", () => {
    expect(resolveLinks("see [[personalized pagerank]]", INDEX)).toBe(
      "see [[Personalized PageRank|personalized pagerank]]",
    );
  });

  it("retargets an already-piped link while keeping the display text", () => {
    expect(resolveLinks("[[PPR|the ranking step]]", INDEX)).toBe(
      "[[Personalized PageRank|the ranking step]]",
    );
  });

  it("leaves an unresolved link untouched — a future-article signal, not an error", () => {
    const body = "Someday: [[Spectral Clustering]] and [[Nothing Here|this]].";
    expect(resolveLinks(body, INDEX)).toBe(body);
  });

  it("leaves full-path source links untouched even when one resolves (§4)", () => {
    // The alias is the raw path itself, so the exemption — not a failed
    // lookup — is what has to keep the link intact.
    const index = buildTitleIndex([page("Paper", ["raw/paper.md"])]);
    const body = "Source: [[raw/paper.md]] and [[raw/answers/a.md|the answer]].";
    expect(resolveLinks(body, index)).toBe(body);
  });

  it("leaves heading and block references untouched even when one resolves", () => {
    const index = buildTitleIndex([page("Update Page", ["PPR#The update", "PPR^abc123"])]);
    const body = "[[PPR#The update]] and [[PPR^abc123]]";
    expect(resolveLinks(body, index)).toBe(body);
  });

  it("rewrites every link on a line, not just the first", () => {
    expect(resolveLinks("[[PPR]] vs [[quicksilver]]", INDEX)).toBe(
      "[[Personalized PageRank|PPR]] vs [[Mercury (element)|quicksilver]]",
    );
  });

  it("preserves a qualified title that is already canonical", () => {
    const body = "[[Mercury (element)]]";
    expect(resolveLinks(body, INDEX)).toBe(body);
  });

  it("tolerates whitespace inside the brackets", () => {
    expect(resolveLinks("[[ PPR ]]", INDEX)).toBe("[[Personalized PageRank|PPR]]");
  });

  it("leaves prose without links completely unchanged", () => {
    const body = "No links here. Brackets [not a link] and [[]] too.";
    expect(resolveLinks(body, INDEX)).toBe(body);
  });

  it("is stable: running the post-pass twice changes nothing further", () => {
    const once = resolveLinks("[[PPR]] and [[quicksilver]]", INDEX);
    expect(resolveLinks(once, INDEX)).toBe(once);
  });
});

describe("linkTargets", () => {
  it("collects distinct targets in first-seen order, stripping display text", () => {
    expect(linkTargets("[[B]] then [[A|shown]] then [[B]]")).toEqual(["B", "A"]);
  });

  it("returns nothing for a body with no links", () => {
    expect(linkTargets("plain prose")).toEqual([]);
  });
});
