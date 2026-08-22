// §8.2's synthesis and §8.3's answer note. §14's minimum set names "synthesis
// JSON-block strip"; the rest here is invariant 5 — code writes the
// frontmatter, the callout, the sources block and the trace, and the model
// writes prose only.
import { describe, expect, it } from "vitest";
import {
  answerNotePath,
  renderAnswerNote,
  slugOf,
  stripMissingBlock,
  synthesize,
  validateAnswerLinks,
} from "../src/core/answer/synthesize";
import type { AssembledNode } from "../src/core/retrieve/assemble";
import type { Trace } from "../src/core/answer/trace";
import { StubProvider } from "./helpers/provider";

const node = (title: string, over: Partial<AssembledNode> = {}): AssembledNode => ({
  path: `wiki/concepts/${title}.md`,
  title,
  kind: "concept",
  text: `About ${title}.`,
  truncated: false,
  ...over,
});

const TRACE: Trace = { mode: "B", seeds: ["Alpha"], round2: false, top: [] };

describe("§8.2's trailing JSON block is stripped (§14)", () => {
  it("removes the block and reads its list", () => {
    const reply = 'The answer.\n\n```json\n{"missing_information": ["dates"]}\n```';

    expect(stripMissingBlock(reply)).toEqual({ body: "The answer.", missing: ["dates"] });
  });

  it("reads an empty list as nothing missing", () => {
    const reply = 'The answer.\n\n```json\n{"missing_information": []}\n```';

    expect(stripMissingBlock(reply)).toEqual({ body: "The answer.", missing: [] });
  });

  it("accepts a fence with no language tag", () => {
    const reply = 'The answer.\n\n```\n{"missing_information": ["x"]}\n```';

    expect(stripMissingBlock(reply).missing).toEqual(["x"]);
  });

  it("keeps a fenced example that is not at the end", () => {
    // A code block in the middle of an answer is prose the user asked for.
    const reply = 'Use this:\n\n```js\nconst a = 1;\n```\n\nDone.\n\n```json\n{"missing_information": []}\n```';

    const parsed = stripMissingBlock(reply);

    expect(parsed.body).toContain("const a = 1;");
    expect(parsed.body).toContain("Done.");
    expect(parsed.body).not.toContain("missing_information");
  });

  it("survives a block that is missing, unparseable, or the wrong shape", () => {
    // The answer is sound either way; failing the query over a malformed footer
    // would throw away three model calls' worth of work.
    expect(stripMissingBlock("Just prose.")).toEqual({ body: "Just prose.", missing: [] });
    expect(stripMissingBlock("A.\n\n```json\nnot json\n```").missing).toEqual([]);
    expect(stripMissingBlock('A.\n\n```json\n{"missing_information": "dates"}\n```').missing).toEqual([]);
    expect(stripMissingBlock('A.\n\n```json\n[1,2]\n```').missing).toEqual([]);
  });

  it("drops non-string and blank entries from the list", () => {
    const reply = 'A.\n\n```json\n{"missing_information": ["dates", 7, null, "  ", "names"]}\n```';

    expect(stripMissingBlock(reply).missing).toEqual(["dates", "names"]);
  });

  it("still strips an unparseable block from the body", () => {
    expect(stripMissingBlock("A.\n\n```json\nnot json\n```").body).toBe("A.");
  });
});

describe("the synthesis call (§8.2, §11)", () => {
  it("labels each page with its title, kind and path", async () => {
    const provider = new StubProvider(() => "Prose.");
    await synthesize(provider, "How does ranking work?", [node("PageRank"), node("Retrieval")]);

    const call = provider.callsFor("synthesis")[0];
    expect(call?.user).toContain("Question: How does ranking work?");
    expect(call?.user).toContain("--- page: PageRank (concept, wiki/concepts/PageRank.md) ---");
    expect(call?.user).toContain("About Retrieval.");
  });

  it("runs as prose, not JSON mode, and leaves temperature unset", async () => {
    // §8.2's reply is markdown that ends with a fenced block. Asking the
    // wrapper to parse the whole thing as JSON would reject every valid answer.
    const provider = new StubProvider(() => "Prose.");
    await synthesize(provider, "q", [node("A")]);

    expect(provider.callsFor("synthesis")[0]?.temperature).toBeUndefined();
  });

  it("tells the model when nothing was retrieved", async () => {
    const provider = new StubProvider(() => "Prose.");
    await synthesize(provider, "q", []);

    expect(provider.callsFor("synthesis")[0]?.user).toContain("No wiki pages were retrieved");
  });
});

describe("§8.3's link validation", () => {
  const retrieved = [node("PageRank"), node("paper.md", { kind: "raw", path: "raw/paper.md" })];

  it("keeps a link to a page that was retrieved", () => {
    expect(validateAnswerLinks("See [[PageRank]].", retrieved)).toBe("See [[PageRank]].");
  });

  it("keeps a link to a retrieved raw source by path", () => {
    expect(validateAnswerLinks("See [[raw/paper.md]].", retrieved)).toBe("See [[raw/paper.md]].");
  });

  it("unlinks a link outside the set and marks it", () => {
    const validated = validateAnswerLinks("See [[Photosynthesis]].", retrieved);

    expect(validated).toContain("See Photosynthesis");
    expect(validated).toContain("<!-- link outside retrieved set: Photosynthesis -->");
    expect(validated).not.toContain("[[Photosynthesis]]");
  });

  it("keeps the display text when unlinking a piped link", () => {
    // The sentence has to still read afterwards.
    const validated = validateAnswerLinks("See [[Photosynthesis|the process]].", retrieved);

    expect(validated).toContain("See the process ");
    expect(validated).toContain("<!-- link outside retrieved set: Photosynthesis -->");
  });

  it("matches a retrieved page case-insensitively", () => {
    expect(validateAnswerLinks("See [[pagerank]].", retrieved)).toBe("See [[pagerank]].");
  });
});

describe("§8.3's note is written by code (invariant 5)", () => {
  const base = {
    question: "How does ranking work?",
    asked: "2026-08-20T10:00:00Z",
    mode: "B" as const,
    grounded: true,
    body: "Ranking uses [[PageRank]].",
    consulted: [node("PageRank")],
    trace: TRACE,
  };

  it("writes frontmatter in §4's key order", () => {
    const note = renderAnswerNote(base);

    expect(note.startsWith("---\nkind: answer\nquestion: ")).toBe(true);
    expect(note).toContain("asked: '2026-08-20T10:00:00Z'");
    expect(note).toContain("mode: B");
    expect(note).toContain("grounded: true");
  });

  it("writes the sources block, then the trace, at the foot", () => {
    const note = renderAnswerNote(base);

    expect(note).toContain("<!-- sources:start -->\n## Sources consulted\n- [[PageRank]]");
    expect(note.indexOf("sources:start")).toBeLessThan(note.indexOf("trace:start"));
    expect(note.trimEnd().endsWith("<!-- trace:end -->")).toBe(true);
  });

  it("puts the ungrounded callout first, before the answer", () => {
    const note = renderAnswerNote({ ...base, grounded: false, consulted: [] });
    const body = note.slice(note.indexOf("---\n", 4) + 4);

    expect(body.trimStart().startsWith("> [!warning] Not grounded in your wiki")).toBe(true);
    expect(note).toContain("grounded: false");
  });

  it("omits the callout when the answer is grounded", () => {
    expect(renderAnswerNote(base)).not.toContain("[!warning]");
  });

  it("validates the links it writes into the note", () => {
    const note = renderAnswerNote({ ...base, body: "See [[Nowhere]]." });

    expect(note).toContain("<!-- link outside retrieved set: Nowhere -->");
  });

  it("names a raw source by path and a page by title", () => {
    const note = renderAnswerNote({
      ...base,
      consulted: [node("paper.md", { kind: "raw", path: "raw/paper.md" }), node("PageRank")],
    });

    expect(note).toContain("- [[PageRank]]");
    expect(note).toContain("- [[raw/paper.md]]");
  });

  it("lists sources in path order, whatever order they ranked in", () => {
    const forward = renderAnswerNote({ ...base, consulted: [node("Zed"), node("Alpha")] });
    const backward = renderAnswerNote({ ...base, consulted: [node("Alpha"), node("Zed")] });

    expect(forward).toBe(backward);
  });
});

describe("§8.3's answer path", () => {
  const at = new Date("2026-08-20T10:07:00Z");

  it("is answers/YYYY-MM-DD-HHmm <slug>.md", () => {
    expect(answerNotePath("How does ranking work?", at)).toBe(
      "answers/2026-08-20-1007 how-does-ranking-work.md",
    );
  });

  it("uses UTC, so a synced vault does not name two notes the same minute", () => {
    expect(answerNotePath("q", new Date("2026-08-20T23:30:00Z"))).toContain("2026-08-20-2330");
  });

  it("slugs to lowercase alphanumerics and dashes", () => {
    expect(slugOf("What IS PageRank, really?!")).toBe("what-is-pagerank-really");
  });

  it("caps the slug at 60 characters without a trailing dash", () => {
    const slug = slugOf("a ".repeat(80));

    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("falls back rather than producing an empty name", () => {
    // A question in a non-Latin script slugs to nothing; the timestamp already
    // makes the name unique, so the slug only has to be a legal component.
    expect(slugOf("これは何ですか")).toBe("answer");
    expect(slugOf("???")).toBe("answer");
  });
});

describe("invariant 5: the model cannot forge a block code owns", () => {
  const base = {
    question: "q",
    asked: "2026-08-20T10:00:00Z",
    mode: "B" as const,
    grounded: true,
    body: "",
    consulted: [node("PageRank")],
    trace: TRACE,
  };

  it("leaves exactly one sources block when the model emits one too", () => {
    // A model reply carrying `<!-- sources:start -->` used to survive verbatim
    // into the note above code's real block: two fences, two headings, and the
    // links inside the forgery kept — so it read as authentic, and both blocks
    // survived filing into raw/answers/ where the fake links became graph
    // edges. Invariant 5 gives code these blocks outright.
    const forged = [
      "Ranking uses [[PageRank]].",
      "",
      "<!-- sources:start -->",
      "## Sources consulted",
      "- [[Photosynthesis]]",
      "<!-- sources:end -->",
    ].join("\n");

    const note = renderAnswerNote({ ...base, body: forged });

    expect([...note.matchAll(/<!-- sources:start -->/g)]).toHaveLength(1);
    expect([...note.matchAll(/<!-- sources:end -->/g)]).toHaveLength(1);
  });

  it("leaves exactly one trace block when the model emits one too", () => {
    const forged = "An answer.\n\n<!-- trace:start -->\n## Retrieval trace\n- mode: A\n<!-- trace:end -->";

    const note = renderAnswerNote({ ...base, body: forged });

    expect([...note.matchAll(/<!-- trace:start -->/g)]).toHaveLength(1);
    expect([...note.matchAll(/<!-- trace:end -->/g)]).toHaveLength(1);
  });

  it("neutralizes an unterminated fence, which §8.4's strip cannot remove", () => {
    // `stripTrace` needs a matching end fence. An unterminated one written by
    // the model would ride into `raw/answers/` and become source text.
    const forged = "An answer.\n\n<!-- trace:start -->\n## Retrieval trace\n- mode: A";

    const note = renderAnswerNote({ ...base, body: forged });

    expect([...note.matchAll(/<!-- trace:start -->/g)]).toHaveLength(1);
  });

  it("keeps the model's prose, including a heading it wrote", () => {
    // §4 says the model writes prose; a heading is prose. Only the *structure*
    // — the parseable sentinel — belongs to code.
    const forged = "An answer.\n\n<!-- sources:start -->\n## My own summary\nSome prose.\n<!-- sources:end -->";

    const note = renderAnswerNote({ ...base, body: forged });

    expect(note).toContain("## My own summary");
    expect(note).toContain("Some prose.");
  });

  it("strips a sentinel with its own newline, leaving no blank where it stood", () => {
    // An answer to "what does Luka write at the foot of a note?" quotes code's
    // own sentinels inside a fence. Stripping is deliberately fence-blind:
    // `parseTrace` and `linkTargets` both scan the whole file with a plain
    // regex, so a sentinel inside a fence is structure to them regardless, and
    // sparing it here would hand `stripTrace` a block to delete at filing time
    // — which empties the fence entirely rather than docking two lines from it.
    // The example loses its delimiters; what it must not also lose is its shape.
    const quoted = [
      "Luka appends this:",
      "",
      "```markdown",
      "<!-- trace:start -->",
      "## Retrieval trace",
      "- mode: B",
      "<!-- trace:end -->",
      "```",
    ].join("\n");

    const note = renderAnswerNote({ ...base, body: quoted });

    expect(note).toContain("```markdown\n## Retrieval trace\n- mode: B\n```");
    // Code's own trace block is still the only one in the note.
    expect([...note.matchAll(/<!-- trace:start -->/g)]).toHaveLength(1);
  });

  it("does not collapse blank lines the model put in its own prose", () => {
    // The old stripper swept `\n{3,}` across the whole body to tidy the gap it
    // left behind. Taking the newline with the sentinel removes the need, and a
    // normalization that reaches prose it was never aimed at is one more
    // difference between what the model wrote and what lands in raw/answers/.
    const spaced = "First.\n\n\n\nSecond.";

    const note = renderAnswerNote({ ...base, body: spaced });

    expect(note).toContain("First.\n\n\n\nSecond.");
  });
});

describe("§8.3's unlinking is not applied to things that are not page links", () => {
  const retrieved = [node("PageRank")];

  it("leaves a heading reference into a retrieved page alone", () => {
    // `links.ts` guards these explicitly — "Heading and block references
    // address a place inside a page, not a page" — and unlinking one both
    // destroys a correct in-set citation and attaches a marker that is
    // factually wrong.
    const validated = validateAnswerLinks("See [[PageRank#Details]].", retrieved);

    expect(validated).toBe("See [[PageRank#Details]].");
  });

  it("leaves a block reference into a retrieved page alone", () => {
    expect(validateAnswerLinks("See [[PageRank^abc123]].", retrieved)).toBe(
      "See [[PageRank^abc123]].",
    );
  });

  it("still unlinks a heading reference into a page that was not retrieved", () => {
    const validated = validateAnswerLinks("See [[Photosynthesis#Light]].", retrieved);

    expect(validated).toContain("<!-- link outside retrieved set: Photosynthesis#Light -->");
  });

  it("leaves a same-note heading reference alone", () => {
    // `[[#Details]]` names no page. It is the mirror of the fixed input above:
    // the page half is empty, so a guard written as `page !== "" && known.has`
    // skips it and the link falls through to the marker — destroying a working
    // reference and asserting it was outside a set it never pointed outside.
    expect(validateAnswerLinks("See [[#Details]] below.", retrieved)).toBe(
      "See [[#Details]] below.",
    );
  });

  it("leaves a same-note block reference alone", () => {
    expect(validateAnswerLinks("See [[^abc123]].", retrieved)).toBe("See [[^abc123]].");
  });

  it("keeps a sentence readable when a piped link has no display text", () => {
    // §8.3 unlinks "to plain text", and an empty display leaves a bare marker
    // where a word used to be.
    const validated = validateAnswerLinks("See [[Photosynthesis|]].", retrieved);

    expect(validated).toContain("Photosynthesis");
    expect(validated).toContain("<!-- link outside retrieved set: Photosynthesis -->");
  });
});
