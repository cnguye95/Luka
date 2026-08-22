// §7.4 step 3's lexical scorer, which §14 names in the minimum unit set.
import { describe, expect, it } from "vitest";
import { lexicalScore, type LexicalPage } from "../src/core/retrieve/lexical";

// §7.4's weights, redeclared here rather than imported: a spec number has to
// come from the spec, or the test agrees with the code by construction.
const SPEC_TITLE_EXACT = 10;
const SPEC_ALIAS_EXACT = 8;
const SPEC_SUBSTRING = 4;
const SPEC_IN_SUMMARY = 2;
const SPEC_IN_BODY = 1;

const page = (over: Partial<LexicalPage> = {}): LexicalPage => ({
  title: "Personalized PageRank",
  aliases: ["PPR"],
  summary: "A seeded random walk.",
  ...over,
});

const BODY = "The walk restarts at its seeds every step, which biases it.";

const score = (keywords: string[], over: Partial<LexicalPage> = {}, body = BODY) =>
  lexicalScore(page(over), body, keywords);

describe("each tier scores what §7.4 says it scores", () => {
  it("gives an exact title match 10", () => {
    expect(score(["Personalized PageRank"])).toBe(SPEC_TITLE_EXACT);
  });

  it("gives an exact alias match 8", () => {
    expect(score(["PPR"])).toBe(SPEC_ALIAS_EXACT);
  });

  it("gives a title or alias substring 4", () => {
    expect(score(["PageRank"])).toBe(SPEC_SUBSTRING);
    expect(score(["PP"])).toBe(SPEC_SUBSTRING);
  });

  it("gives a keyword in the summary 2", () => {
    expect(score(["random walk"])).toBe(SPEC_IN_SUMMARY);
  });

  it("gives a keyword in the body 1", () => {
    expect(score(["biases"])).toBe(SPEC_IN_BODY);
  });

  it("gives a keyword that appears nowhere 0", () => {
    expect(score(["photosynthesis"])).toBe(0);
  });
});

describe("a keyword takes its best tier and only that one", () => {
  it("does not also collect the lower tiers it satisfies", () => {
    // The discriminating case is the second one: a page whose title, summary
    // and body all hold the keyword scores 10, not 10+2+1.
    // "Personalized PageRank" is an exact title, and it is also a substring of
    // the title, and it appears in neither summary nor body. Adding the tiers
    // instead of choosing one would score 14 here and would make an exact
    // title on a page that also mentions it in its body outrank an exact title
    // on a page that does not — ranking pages by verbosity.
    expect(score(["Personalized PageRank"])).toBe(SPEC_TITLE_EXACT);

    const mentioned = score(["walk"], { title: "Walk", summary: "A walk.", aliases: [] }, "walk walk");
    expect(mentioned).toBe(SPEC_TITLE_EXACT);
  });
});

describe("keywords sum", () => {
  it("adds one tier per keyword", () => {
    expect(score(["PPR", "biases"])).toBe(SPEC_ALIAS_EXACT + SPEC_IN_BODY);
  });

  it("scores an empty keyword list 0", () => {
    expect(score([])).toBe(0);
  });

  it("ignores a blank keyword rather than matching everything", () => {
    // "" is a substring of every string. Left in, it would hand every page the
    // body tier and flatten the ranking.
    expect(score(["   "])).toBe(0);
    expect(score(["PPR", ""])).toBe(SPEC_ALIAS_EXACT);
  });
});

describe("matching folds case and Unicode form, like every other handle", () => {
  it("matches a title whatever case it is written in", () => {
    expect(score(["personalized pagerank"])).toBe(SPEC_TITLE_EXACT);
    expect(score(["ppr"])).toBe(SPEC_ALIAS_EXACT);
  });

  it("matches across NFC and NFD spellings", () => {
    // The same reason §4's namespace has one spelling rule: a title on disk in
    // one form and a query in the other name the same thing.
    expect(score(["Café"], { title: "Café", aliases: [] })).toBe(SPEC_TITLE_EXACT);
  });

  it("ignores an alias that is blank", () => {
    // The keyword here is deliberately *not* blank. A blank keyword is
    // short-circuited before any alias is consulted, so the first version of
    // this test — which passed one — exercised the blank-keyword guard and
    // never reached the alias path at all.
    //
    // The blank alias matters because `contains` asks `keyword.includes(name)`,
    // and every string contains "". One empty entry in a page's `aliases:`
    // would otherwise score every keyword at the substring tier, floating that
    // page to the top of every Mode A ranking.
    expect(score(["photosynthesis"], { aliases: ["  ", "PPR"] })).toBe(0);
  });
});

describe("substring matching works in both directions", () => {
  it("matches a keyword that contains the title", () => {
    expect(score(["pageranking"], { title: "PageRank", aliases: [] })).toBe(SPEC_SUBSTRING);
  });

  it("matches a keyword the title contains", () => {
    expect(score(["rank"], { title: "PageRank", aliases: [] })).toBe(SPEC_SUBSTRING);
  });
});
