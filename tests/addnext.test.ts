// The answer note's `## Add next` section.
//
// Two properties carry most of these. The section is a pure function of what
// the answer already held, so two answers over one vault write one section
// (`ask` asserts the byte-identity). And nothing it writes can become a link:
// `linkTargets` is fence-blind, so a `[[` inside the Mermaid fence would be a
// §7.1 edge to a page that does not exist — which is the opposite of what a
// recommendation to write that page should do.
import { describe, expect, it } from "vitest";
import { answerGaps, mermaidLabel, renderGapsBlock, stripGaps } from "../src/core/answer/addnext";
import { linkTargets } from "../src/core/compile/links";
import type { AssembledNode } from "../src/core/retrieve/assemble";
import type { GraphSnapshot, PageMeta } from "../src/core/types";

const node = (
  path: string,
  title: string,
  text: string,
  over: Partial<AssembledNode> = {},
): AssembledNode => ({ path, title, kind: "concept", text, truncated: false, ...over });

const meta = (path: string, title: string, aliases: string[] = []): PageMeta =>
  ({ path, title, kind: "concept", aliases, summary: "", updated: "2026-08-20" }) as PageMeta;

const gapsOf = (
  missing: string[],
  consulted: AssembledNode[],
  pages: PageMeta[] = [],
): ReturnType<typeof answerGaps> => answerGaps({ missing, consulted, pages });

describe("what the answer ran into", () => {
  it("names a link the consulted pages reached for and the wiki does not have", () => {
    const gaps = gapsOf([], [node("wiki/concepts/A.md", "Airships", "Lift from [[Zeppelin]].")]);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.title).toBe("Zeppelin");
    expect(gaps[0]?.fromAnswer).toBe(false);
    expect(gaps[0]?.citers.map((c) => c.title)).toEqual(["Airships"]);
  });

  it("puts what synthesis said it lacked first, in its own order", () => {
    // §8.2's list is the model reporting on its own answer, which is a
    // stronger statement about this question than a link on a page it read.
    // Its order is the frontmatter's, so the note does not say two things.
    const gaps = gapsOf(
      ["the passenger manifest", "the 1937 weather"],
      [
        node("wiki/concepts/A.md", "Airships", "Lift from [[Zeppelin]] and [[Helium]]."),
        node("wiki/concepts/B.md", "Hindenburg", "A [[Zeppelin]]."),
      ],
    );

    expect(gaps.map((g) => g.title)).toEqual([
      "the passenger manifest",
      "the 1937 weather",
      // Then the links, most wanted first.
      "Zeppelin",
      "Helium",
    ]);
  });

  it("merges a link and a synthesis item that name the same page", () => {
    // One gap with two kinds of evidence, not two gaps. It keeps the model's
    // place and takes the pages, so the count in the sentence stays true.
    const gaps = gapsOf(
      ["zeppelin"],
      [node("wiki/concepts/A.md", "Airships", "Lift from [[Zeppelin]].")],
    );

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.title).toBe("zeppelin");
    expect(gaps[0]?.fromAnswer).toBe(true);
    expect(gaps[0]?.citers).toHaveLength(1);
  });

  it("does not read a raw source's links", () => {
    // A raw source is a file, not a §4 page: its links are its author's, and
    // §4 does not resolve them against the title table.
    const gaps = gapsOf([], [node("raw/note.md", "note.md", "See [[Zeppelin]].", { kind: "raw" })]);

    expect(gaps).toEqual([]);
  });

  it("does not name a page an alias already answers to", () => {
    const gaps = gapsOf(
      [],
      [node("wiki/concepts/A.md", "Airships", "See [[PPR]].")],
      [meta("wiki/concepts/PageRank.md", "PageRank", ["PPR"])],
    );

    expect(gaps).toEqual([]);
  });

  it("names an accented page whose spellings differ by Unicode form", () => {
    // The shown spelling is the `comparePaths`-minimum, and NFD sorts before
    // NFC — so a gate comparing bytes against a form that normalizes to NFC
    // refused every accented name. The recommendation was real and actionable;
    // it was dropped for a reason that had nothing to do with the name.
    const gaps = gapsOf([], [
      node("wiki/concepts/A.md", "A", "See [[Café culture]]."),
      node("wiki/concepts/B.md", "B", "See [[Café culture]]."),
    ]);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.title.normalize("NFC")).toBe("Café culture");
    expect(gaps[0]?.citers).toHaveLength(2);
  });

  it("refuses a name longer than the namespace allows", () => {
    // §4's namespace has two rules — how names compare and how long a name may
    // be — and a name that cannot be stored under the name it was asked for is
    // not a recommendation anyone can act on.
    const within = "x".repeat(200);
    const beyond = "x".repeat(201);

    expect(gapsOf([], [node("wiki/concepts/A.md", "A", `See [[${within}]].`)])).toHaveLength(1);
    expect(gapsOf([], [node("wiki/concepts/A.md", "A", `See [[${beyond}]].`)])).toEqual([]);
  });

  it("refuses a name §4 would have to rewrite to store", () => {
    // Forbidden characters, the reserved `_` prefix, and a name that sanitizes
    // to nothing at all.
    const gaps = gapsOf([], [
      node("wiki/concepts/A.md", "A", "See [[a/b]], [[_index]] and [[...]]."),
    ]);

    expect(gaps).toEqual([]);
  });

  it("drops a name that reads as code rather than as an article", () => {
    // Page generation invites the model to link freely, and on the measured
    // vaults it produced these. Nobody writes an article called `link_pairs`.
    const gaps = gapsOf([], [
      node("wiki/concepts/A.md", "A", "See [[link_pairs]], [[linkTargets]], [[2026]], [[Graph pane]]."),
    ]);

    expect(gaps.map((g) => g.title)).toEqual(["Graph pane"]);
  });

  it("names at most five links, the most wanted first", () => {
    // Synthesis's own items are not capped — they are the `missing:` key, and
    // a section shorter than the key would be the second of two answers.
    const consulted = ["A", "B", "C", "D", "E", "F"].map((name, index) =>
      node(`wiki/concepts/${name}.md`, name, `See ${["G1", "G2", "G3", "G4", "G5", "G6"].slice(0, index + 1).map((g) => `[[${g}]]`).join(" ")}.`),
    );

    const gaps = gapsOf(["one", "two"], consulted);

    expect(gaps.filter((g) => g.fromAnswer)).toHaveLength(2);
    expect(gaps.filter((g) => !g.fromAnswer).map((g) => g.title)).toEqual([
      "G1",
      "G2",
      "G3",
      "G4",
      "G5",
    ]);
  });

  it("gives the same answer for pages consulted in the opposite order", () => {
    const consulted = [
      node("wiki/concepts/A.md", "Airships", "See [[zeppelin]]."),
      node("wiki/concepts/B.md", "Hindenburg", "See [[Zeppelin]]."),
    ];

    expect(gapsOf([], [...consulted].reverse())).toEqual(gapsOf([], consulted));
  });

  it("reads the text synthesis read, not the file behind it", () => {
    // An oversized first page is tail-cut before the model sees it. The
    // section reports on the answer that was given, so a link the model was
    // never shown is not a gap this answer ran into. No mutation makes this
    // red — it pins a decision, so that changing it is a decision too.
    const gaps = gapsOf([], [
      node("wiki/concepts/A.md", "Airships", "Lift comes from gas.", { truncated: true }),
    ]);

    expect(gaps).toEqual([]);
  });
});

describe("what the section says", () => {
  const two = () =>
    gapsOf(
      ["the passenger manifest"],
      [
        node("wiki/concepts/Airships.md", "Airships", "Lift from [[Zeppelin]]."),
        node("wiki/entities/Hindenburg.md", "Hindenburg", "A [[Zeppelin]]."),
      ],
    );

  const graph = (): GraphSnapshot =>
    ({
      nodes: [],
      edges: [{ a: "wiki/concepts/Airships.md", b: "wiki/entities/Hindenburg.md" }],
    }) as GraphSnapshot;

  it("writes nothing when the answer lacked nothing", () => {
    // Matching the `missing:` key, which is omitted rather than written empty.
    expect(renderGapsBlock([], graph())).toBe("");
  });

  it("writes the block the note carries, exactly", () => {
    expect(renderGapsBlock(two(), graph())).toBe(
      [
        "<!-- gaps:start -->",
        "## Add next",
        "- **the passenger manifest** — the wiki could not answer this",
        "- **Zeppelin** — wanted by 2 of the pages consulted: Airships, Hindenburg",
        "",
        "```mermaid",
        "graph LR",
        '  a(["This answer"])',
        '  p0["Airships"]',
        '  p1["Hindenburg"]',
        '  g0["the passenger manifest"]:::gap',
        '  g1["Zeppelin"]:::gap',
        "  a -.- g0",
        "  p0 -.- g1",
        "  p1 -.- g1",
        "  p0 --- p1",
        "  classDef gap stroke-dasharray:5 5,fill:none",
        "```",
        "<!-- gaps:end -->",
      ].join("\n"),
    );
  });

  it("draws solid edges only between pages the diagram already shows", () => {
    // The solid edges are what the wiki holds, so the dashes read as the
    // addition to it. An edge to a page that is not drawn would name a node
    // Mermaid has never heard of.
    const gaps = gapsOf([], [node("wiki/concepts/Airships.md", "Airships", "See [[Zeppelin]].")]);
    const wider: GraphSnapshot = {
      nodes: [],
      edges: [
        { a: "wiki/concepts/Airships.md", b: "wiki/concepts/Elsewhere.md" },
        { a: "wiki/concepts/Elsewhere.md", b: "wiki/concepts/Other.md" },
      ],
    } as GraphSnapshot;

    const block = renderGapsBlock(gaps, wider);

    expect(block).not.toContain("---");
    expect(block).not.toContain("Elsewhere");
  });

  it("draws the answer only when synthesis named something", () => {
    const fromLinks = gapsOf([], [node("wiki/concepts/A.md", "A", "See [[Zeppelin]].")]);

    expect(renderGapsBlock(fromLinks)).not.toContain('a(["This answer"])');
    expect(renderGapsBlock(gapsOf(["a gap"], []))).toContain('a(["This answer"])');
  });

  it("cannot write a wikilink, whatever the gap is called", () => {
    // Mermaid's subroutine shape is spelled `[[Label]]`, which is a §7.1 edge
    // to `linkTargets`. So the brackets are escaped along with the syntax.
    // Synthesis's own words are the vector that matters: a link target cannot
    // carry `]` and so cannot reach a label, but §8.2's items are free prose.
    const gaps = gapsOf(['[X] & <y> "z" #1 `q` {w} |v| 100% \\'], []);

    const block = renderGapsBlock(gaps);

    expect(block).toContain(
      "#91;X#93; #38; #60;y#62; #34;z#34; #35;1 #96;q#96; #123;w#125; #124;v#124; 100#37; #92;",
    );
    expect(linkTargets(block)).toEqual([]);
    expect(block).not.toContain("[[");
  });

  it("never uses the word the frontmatter key uses", () => {
    // `synthesize.test.ts` asserts the substring is absent from a whole note
    // that lacked nothing. The fixed wording has to stay clear of it.
    expect(renderGapsBlock(gapsOf(["x"], []))).not.toMatch(/missing/i);
  });
});

describe("labels", () => {
  it("cuts a long name before escaping it, so no entity is cut in half", () => {
    // Escaping first would turn one character into five and then cut through
    // the middle of an entity, leaving `#3` in the diagram.
    const label = mermaidLabel(`${"x".repeat(45)}"tail"`);

    expect(label.endsWith("…")).toBe(true);
    expect(label).not.toContain("#34;");
    expect([...label]).toHaveLength(41);
  });

  it("flattens whitespace, so a label cannot break the line it is on", () => {
    expect(mermaidLabel("two\n  words")).toBe("two words");
  });
});

describe("filing", () => {
  const noteWith = (block: string) =>
    ["---", "kind: answer", "---", "The answer.", "", block, "", "tail"].join("\n");

  it("removes the section, leaving the note a note without one would have left", () => {
    // The property filing needs: an answer that named gaps and one that named
    // none file to the same shape, so the section cannot be inferred from what
    // is left behind.
    const block = renderGapsBlock(gapsOf(["a gap"], []));

    expect(stripGaps(noteWith(block))).toBe(stripGaps(noteWith("")));
    expect(stripGaps(noteWith(block))).not.toContain("## Add next");
    expect(stripGaps(noteWith(block))).toContain("The answer.");
    expect(stripGaps(noteWith(block))).toContain("tail");
  });

  it("leaves a block alone when the heading is not the one code writes", () => {
    // Same rule as the trace's: a stray sentinel in prose cannot pair with the
    // real one and swallow the text between them.
    const forged = ["<!-- gaps:start -->", "## Something else", "- a bullet", "<!-- gaps:end -->"].join("\n");

    expect(stripGaps(noteWith(forged))).toContain("## Something else");
  });
});
