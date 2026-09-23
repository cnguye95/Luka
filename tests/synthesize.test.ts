// Synthesis and the answer note, including the synthesis JSON-block strip;
// the rest here is invariant 5 — code writes the frontmatter, the callout,
// the sources block and the trace, and the model writes prose only.
import { describe, expect, it } from "vitest";
import {
  answerNotePath,
  cleanMissing,
  renderAnswerNote,
  slugOf,
  stripMissingBlock,
  synthesize,
  validateAnswerLinks,
  withoutForgedBlocks,
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

const TRACE: Trace = { mode: "B", seeds: ["Alpha"], round2: false, top: [], unparsed: [] };

describe("the trailing JSON block is stripped", () => {
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

describe("the synthesis call", () => {
  it("labels each page with its title, kind and path", async () => {
    const provider = new StubProvider(() => "Prose.");
    await synthesize(provider, "How does ranking work?", [node("PageRank"), node("Retrieval")]);

    const call = provider.callsFor("synthesis")[0];
    expect(call?.user).toContain("Question: How does ranking work?");
    expect(call?.user).toContain("--- page: PageRank (concept, wiki/concepts/PageRank.md) ---");
    expect(call?.user).toContain("About Retrieval.");
  });

  it("runs as prose, not JSON mode, and leaves temperature unset", async () => {
    // The reply is markdown that ends with a fenced block. Asking the
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

describe("link validation", () => {
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

describe("what the model said was missing enters frontmatter as one line each", () => {
  it("flattens an item that spans lines", () => {
    // A newline would make the item a YAML block scalar — structure, which
    // invariant 5 gives to code. Same rule `inventory.ts` applies to a summary.
    expect(cleanMissing(["the\n  publication dates"])).toEqual(["the publication dates"]);
  });

  it("strips link brackets, so a filed answer manufactures no edge", () => {
    // `buildGraph` scans a node's whole file for links, frontmatter included.
    expect(cleanMissing(["[[PageRank]] convergence rate"])).toEqual(["PageRank convergence rate"]);
  });

  it("strips to a fixpoint, so it cannot manufacture the link it removes", () => {
    // One pass is not enough: taking `]]` out of the middle splices the
    // brackets that surrounded it into a working link. The strip has to run
    // until the string stops changing, or it writes the very edge it exists to
    // prevent.
    // One pass leaves `[[X]]`, which `linkTargets` reads as a link to X.
    expect(cleanMissing(["[]][X][[]"])).toEqual(["X"]);
    // The mirror shape: removing `[[` closes a `]]` behind it.
    expect(cleanMissing(["funding][[]sources"])).toEqual(["fundingsources"]);
    // And deeper than two passes, so the loop is a fixpoint rather than a
    // second pass bolted onto the first.
    expect(cleanMissing(["[][[][X][]][]"])).toEqual(["X"]);
  });

  it("drops an item that is empty once cleaned", () => {
    expect(cleanMissing(["   ", "[[]]", "dates"])).toEqual(["dates"]);
  });

  it("leaves an ordinary item alone", () => {
    expect(cleanMissing(["who funded the study"])).toEqual(["who funded the study"]);
  });
});

describe("the note is written by code (invariant 5)", () => {
  const base = {
    question: "How does ranking work?",
    asked: "2026-08-20T10:00:00Z",
    mode: "B" as const,
    grounded: true,
    body: "Ranking uses [[PageRank]].",
    consulted: [node("PageRank")],
    trace: TRACE,
  };

  it("writes frontmatter in the fixed key order", () => {
    const note = renderAnswerNote(base);

    expect(note.startsWith("---\nkind: answer\nquestion: ")).toBe(true);
    expect(note).toContain("asked: '2026-08-20T10:00:00Z'");
    expect(note).toContain("mode: B");
    expect(note).toContain("grounded: true");
  });

  it("persists what was still missing, after grounded", () => {
    const note = renderAnswerNote({ ...base, missing: ["dates", "the author"] });

    expect(note).toContain("grounded: true\nmissing:\n  - dates\n  - the author\n---\n");
  });

  it("writes no missing key when nothing was missing", () => {
    // An answer that lacked nothing should not carry a key saying so, and an
    // empty list in the frontmatter would be a claim of its own.
    expect(renderAnswerNote(base)).not.toContain("missing");
    expect(renderAnswerNote({ ...base, missing: [] })).not.toContain("missing");
  });

  it("writes the sources block, then the trace, at the foot", () => {
    const note = renderAnswerNote(base);

    expect(note).toContain("<!-- sources:start -->\n## Sources consulted\n- [[PageRank]]");
    expect(note.indexOf("sources:start")).toBeLessThan(note.indexOf("trace:start"));
    expect(note.trimEnd().endsWith("<!-- trace:end -->")).toBe(true);
  });

  it("writes the Add next section between the sources and the trace", () => {
    // Between them because it is about the answer rather than about the run:
    // a reader who has just seen what was consulted is being told what was
    // not. The trace stays last.
    const note = renderAnswerNote({
      ...base,
      consulted: [node("PageRank", { text: "Ranking needs [[Convergence]]." })],
      missing: ["the dates"],
    });

    expect(note).toContain("## Add next");
    expect(note).toContain("- **the dates** — the wiki could not answer this");
    expect(note).toContain("- **Convergence** — wanted by 1 of the pages consulted: PageRank");
    expect(note).toContain("```mermaid");
    expect(note.indexOf("sources:start")).toBeLessThan(note.indexOf("gaps:start"));
    expect(note.indexOf("gaps:start")).toBeLessThan(note.indexOf("trace:start"));
    expect(note.trimEnd().endsWith("<!-- trace:end -->")).toBe(true);
  });

  it("gives the section the page table, so a link that resolves is not a gap", () => {
    // The section is handed `pages` by its caller. Nothing else observes that
    // it is: the pure function is tested with a page table, and the note is
    // tested for a section, and between them the argument can be dropped.
    const note = renderAnswerNote({
      ...base,
      consulted: [node("Airships", { text: "Lift from [[PageRank]] and [[Zeppelin]]." })],
      pages: [
        {
          path: "wiki/concepts/PageRank.md",
          title: "PageRank",
          kind: "concept",
          aliases: [],
          summary: "",
          updated: "2026-08-20",
        },
      ],
    });

    expect(note).toContain("- **Zeppelin** —");
    expect(note).not.toContain("- **PageRank** —");
  });

  it("gives the section the snapshot, so the diagram shows what the wiki holds", () => {
    const note = renderAnswerNote({
      ...base,
      consulted: [
        node("Airships", { text: "See [[Zeppelin]]." }),
        node("Hindenburg", { text: "See [[Zeppelin]]." }),
      ],
      graph: {
        nodes: [],
        edges: [{ a: "wiki/concepts/Airships.md", b: "wiki/concepts/Hindenburg.md" }],
      },
    });

    expect(note).toContain("  p0 --- p1");
  });

  it("writes no section when the answer ran into nothing", () => {
    // The same rule the `missing:` key follows: an answer that lacked nothing
    // should not carry a heading saying so.
    expect(renderAnswerNote(base)).not.toContain("gaps:start");
    expect(renderAnswerNote(base)).not.toContain("Add next");
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

describe("the answer path", () => {
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

  it("neutralizes an unterminated fence, which filing's strip cannot remove", () => {
    // `stripTrace` needs a matching end fence. An unterminated one written by
    // the model would ride into `raw/answers/` and become source text.
    const forged = "An answer.\n\n<!-- trace:start -->\n## Retrieval trace\n- mode: A";

    const note = renderAnswerNote({ ...base, body: forged });

    expect([...note.matchAll(/<!-- trace:start -->/g)]).toHaveLength(1);
  });

  it("keeps the model's prose, including a heading it wrote", () => {
    // The model writes prose; a heading is prose. Only the *structure*
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

  it("leaves a sentinel alone when prose follows it on the same line", () => {
    // `BLOCK` in trace.ts requires the sentinel to be the whole line, so one
    // with text after it was never parseable and is not a forgery. Matching it
    // anyway ate the first half of this sentence — and left the second
    // sentinel, identical structure, standing.
    const mention = "<!-- trace:start --> and <!-- trace:end --> delimit the trace.";

    const note = renderAnswerNote({ ...base, body: mention });

    expect(note).toContain(mention);
  });

  it("leaves a fenced sentinel that carries an inline annotation", () => {
    // The same asymmetry inside the fence it costs the most: stripping the
    // delimiter here leaves the annotation dangling with nothing to annotate.
    const annotated = ["```markdown", "<!-- trace:start -->   <- code writes this", "```"].join("\n");

    const note = renderAnswerNote({ ...base, body: annotated });

    expect(note).toContain("<!-- trace:start -->   <- code writes this");
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

describe("unlinking is not applied to things that are not page links", () => {
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
    // Unlinking is "to plain text", and an empty display leaves a bare marker
    // where a word used to be.
    const validated = validateAnswerLinks("See [[Photosynthesis|]].", retrieved);

    expect(validated).toContain("Photosynthesis");
    expect(validated).toContain("<!-- link outside retrieved set: Photosynthesis -->");
  });
});

describe("the stripper and the trace parser describe one subject (invariant 5)", () => {
  // `CODE_OWNED_SENTINEL` in synthesize.ts and `BLOCK` in trace.ts both answer
  // "what is a code-owned sentinel", from two sides, written separately. Two
  // consecutive rounds of fixes drifted them apart in opposite directions — one
  // made the stripper tighter than the parser, the next made it looser — so the
  // relationship is pinned here as a property instead of re-derived by eye.
  //
  // Redeclared locally rather than imported: a test that imports the pattern it
  // checks agrees with the code by construction.
  // The parsers that read an answer note: `trace.ts`'s BLOCK and this module's
  // sources block. `compile/citations.ts` has a third BLOCK, deliberately not
  // covered — every `parseCitationBlock` call site iterates the wiki page
  // table, and `loadPageTable` walks `wiki/` alone, so a filed answer's text
  // never reaches it. Covering it would cost an answer that quotes a wiki
  // page's citation block two of its lines, for no parse harm avoided.
  const FIXED_PARSER_SENTINELS = [
    "<!-- trace:start -->",
    "<!-- trace:end -->",
    "<!-- sources:start -->",
    "<!-- sources:end -->",
    "<!-- gaps:start -->",
    "<!-- gaps:end -->",
  ];

  /**
   * Every complete line of `text`. An empty result is zero lines, not one
   * blank one — removing the only line of a body leaves "".
   */
  const linesOf = (text: string) => {
    // One trailing newline is a line *terminator*, not an empty line after it.
    // Without this, stripping a sentinel that ended the body leaves "before\n",
    // which splits to ["before", ""] and reports "" as a line the original
    // never had — a false failure on exactly the end-of-file boundary the
    // anchor is about.
    const body = text.endsWith("\n") ? text.slice(0, -1) : text;
    return body === "" ? [] : body.split("\n");
  };

  it("removes only whole lines, never part of one", () => {
    // The property the `$` anchor carries. `BLOCK` requires a sentinel to be
    // its entire line, so a line with prose after one is structure to nobody,
    // and cutting the sentinel out of it destroys prose for no gain.
    const bodies = [
      "<!-- trace:start --> and <!-- trace:end --> delimit the trace.",
      "Prose about <!-- sources:start --> inline.",
      "<!-- sources:start -->",
      "  <!-- trace:end -->  ",
      "before\n<!-- trace:start -->\nafter",
      "```md\n<!-- trace:start -->   <- annotated\n```",
      "no sentinels here at all",
      "<!-- trace:end -->",
      // Sentinel as the last line, no trailing newline — the end-of-file
      // boundary the `$` half of the anchor exists for.
      "before\n<!-- trace:end -->",
      "a\n<!-- trace:start -->\nb\n<!-- trace:end -->",
    ];

    for (const body of bodies) {
      const kept = linesOf(withoutForgedBlocks(body));
      const original = linesOf(body);
      // Every surviving line must appear verbatim among the original lines, in
      // order — a subsequence. A partial cut produces a line that is not.
      let at = 0;
      for (const line of kept) {
        const found = original.indexOf(line, at);
        expect(found, `"${line}" is not a whole line of ${JSON.stringify(body)}`).toBeGreaterThan(-1);
        at = found + 1;
      }
    }
  });

  it("removes every line the trace parser would accept as a sentinel", () => {
    // Slack is allowed in one direction only: the stripper may be more
    // permissive than the parser, never less. If `BLOCK` would treat a line as
    // structure, that line must not survive into raw/answers/.
    for (const sentinel of FIXED_PARSER_SENTINELS) {
      // `BLOCK` accepts the sentinel at column 0 with optional trailing blanks.
      for (const line of [sentinel, `${sentinel} `, `${sentinel}\t`]) {
        expect(withoutForgedBlocks(`before\n${line}\nafter`)).toBe("before\nafter");
      }
    }
  });

  it("is deliberately more permissive than the parser, in that direction only", () => {
    // `BLOCK` demands column 0 and single interior spaces. The stripper takes
    // indented and loosely spaced near-misses too, so a shape some future
    // parser might accept is already gone.
    expect(withoutForgedBlocks("before\n  <!--  trace:start  -->\nafter")).toBe("before\nafter");
    // And a line the parser could never accept, because prose follows it, is
    // left exactly as the model wrote it.
    const mention = "<!-- trace:start --> is what code writes.";
    expect(withoutForgedBlocks(mention)).toBe(mention);
  });
});
