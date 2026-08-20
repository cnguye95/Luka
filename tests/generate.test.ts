import { describe, expect, it } from "vitest";
import { parseCitationBlock } from "../src/core/compile/citations";
import {
  citerUnion,
  generatePageBody,
  readablePathFor,
  readCitations,
  renderCallBPrompt,
  renderPage,
  type PageToWrite,
} from "../src/core/compile/generate";
import { buildTitleIndex } from "../src/core/compile/links";
import { truncatedForContextBudget } from "../src/core/markers";
import type { PageMeta } from "../src/core/types";
import { MemFs } from "./helpers/memfs";
import { StubProvider } from "./helpers/provider";

const EMPTY_INDEX = buildTitleIndex([]);

function page(title: string, aliases: string[] = [], kind: PageMeta["kind"] = "concept"): PageMeta {
  return { path: `wiki/${title}.md`, title, kind, aliases, summary: "", updated: "2026-08-20" };
}

describe("Call B — the prompt (§6.5)", () => {
  const base = {
    title: "Personalized PageRank",
    kind: "concept" as const,
    aliases: ["PPR"],
    contextBudgetTokens: 40_000,
  };

  it("carries the instructions §6.5 requires", async () => {
    const provider = new StubProvider(() => "Body.");
    await generatePageBody(provider, { ...base, sources: [{ path: "raw/a.md", body: "A." }] });

    const system = provider.callsFor("page-generation")[0]?.system ?? "";
    expect(system).toContain("[[wikilinks]]");
    expect(system.toLowerCase()).toContain("do not write citations");
    expect(system.toLowerCase()).toContain("frontmatter");
    expect(system.toLowerCase()).toContain("repeats the title");
  });

  it("shows the model the page identity and every citing source", () => {
    const prompt = renderCallBPrompt({
      ...base,
      sources: [
        { path: "raw/a.md", body: "First source body." },
        { path: "raw/b.md", body: "Second source body." },
      ],
    });

    expect(prompt).toContain("Title: Personalized PageRank");
    expect(prompt).toContain("Kind: concept");
    expect(prompt).toContain("Aliases: PPR");
    expect(prompt).toContain("raw/a.md");
    expect(prompt).toContain("First source body.");
    expect(prompt).toContain("Second source body.");
  });

  it("assembles sources in citation order", () => {
    const prompt = renderCallBPrompt({
      ...base,
      sources: [
        { path: "raw/second.md", body: "SECOND" },
        { path: "raw/first.md", body: "FIRST" },
      ],
    });
    expect(prompt.indexOf("SECOND")).toBeLessThan(prompt.indexOf("FIRST"));
  });

  it("shows the model the identity and the sources, and nothing else (§6.5)", () => {
    // §6.5: the input is title, kind, aliases and the citing bodies — "never
    // the old page text". `GeneratePageInput` carries no old-page field, so
    // the way to hold that guarantee is to pin the prompt exactly: anything
    // a future change smuggled in would land outside this string.
    const prompt = renderCallBPrompt({
      ...base,
      sources: [{ path: "raw/a.md", body: "Only the source." }],
    });

    expect(prompt).toBe(
      [
        "Title: Personalized PageRank",
        "Kind: concept",
        "Aliases: PPR",
        "",
        "--- source: raw/a.md ---",
        "Only the source.",
      ].join("\n"),
    );
  });

  it("says so explicitly when the page has no aliases", () => {
    const prompt = renderCallBPrompt({ ...base, aliases: [], sources: [] });
    expect(prompt).toContain("Aliases: (none)");
  });

  it("truncates with the marker when one source exceeds the whole budget (§6.5)", () => {
    const prompt = renderCallBPrompt({
      ...base,
      sources: [{ path: "raw/huge.md", body: "x".repeat(20_000) }],
      contextBudgetTokens: 500,
    });

    expect(prompt).toContain(truncatedForContextBudget());
    expect(Math.ceil(prompt.length / 4)).toBeLessThanOrEqual(500);
  });

  it("stops taking sources at the budget rather than reordering them", () => {
    const prompt = renderCallBPrompt({
      ...base,
      sources: [
        { path: "raw/big.md", body: "B".repeat(3_000) },
        { path: "raw/huge.md", body: "H".repeat(3_000) },
        { path: "raw/tiny.md", body: "TINY" },
      ],
      contextBudgetTokens: 900,
    });

    expect(prompt).toContain("BBB");
    expect(prompt).not.toContain("HHH");
    expect(prompt).not.toContain("TINY");
  });

  it("marks the truncation when the budget drops a whole source (§6.5)", () => {
    // §6.5 promises the model "the full normalized bodies of *all* citing
    // sources … truncation marker if the budget forces it". Dropping a source
    // whole is the budget forcing it, and without the marker the model grounds
    // the page in a subset while code writes a block claiming every source.
    const prompt = renderCallBPrompt({
      ...base,
      sources: [
        { path: "raw/first.md", body: "F".repeat(3_000) },
        { path: "raw/dropped.md", body: "D".repeat(3_000) },
      ],
      contextBudgetTokens: 900,
    });

    expect(prompt).toContain(truncatedForContextBudget());
    expect(prompt).toContain("raw/dropped.md");
    expect(prompt).not.toContain("DDD");
  });

  it("adds no marker when every source fits", () => {
    const prompt = renderCallBPrompt({
      ...base,
      sources: [{ path: "raw/a.md", body: "Short." }],
      contextBudgetTokens: 40_000,
    });
    expect(prompt).not.toContain(truncatedForContextBudget());
  });

  it("returns the model prose trimmed and unmodified", async () => {
    const provider = new StubProvider(() => "\n\nThe body with [[Links]].\n\n");
    await expect(
      generatePageBody(provider, { ...base, sources: [] }),
    ).resolves.toBe("The body with [[Links]].");
  });

  it("costs exactly one model call", async () => {
    const provider = new StubProvider(() => "Body.");
    await generatePageBody(provider, { ...base, sources: [] });
    expect(provider.stats().byTask["page-generation"]).toBe(1);
  });
});

describe("citerUnion (§6.5's persistent citer record)", () => {
  const live = () => true;

  it("is surviving entries followed by this run's matches", () => {
    expect(citerUnion(["raw/old.md"], ["raw/new.md"], live)).toEqual(["raw/old.md", "raw/new.md"]);
  });

  it("does not duplicate a source that is both surviving and matched again", () => {
    expect(citerUnion(["raw/a.md"], ["raw/a.md"], live)).toEqual(["raw/a.md"]);
  });

  it("drops an entry that no longer survives", () => {
    const isLive = (path: string) => path !== "raw/deleted.md";
    expect(citerUnion(["raw/deleted.md", "raw/kept.md"], [], isLive)).toEqual(["raw/kept.md"]);
  });

  it("keeps the existing order stable so the Call B prompt does not churn", () => {
    const existing = ["raw/c.md", "raw/a.md", "raw/b.md"];
    expect(citerUnion(existing, ["raw/a.md"], live)).toEqual(existing);
  });

  it("yields nothing when every citer is gone — the §6.6 delete signal", () => {
    expect(citerUnion(["raw/gone.md"], [], () => false)).toEqual([]);
  });
});

describe("readCitations", () => {
  it("reads each page's existing block back as its citer record", async () => {
    const body = [
      "Prose.",
      "",
      "<!-- citations:start -->",
      "## Sources",
      "- [[raw/a.md]]",
      "- [[raw/b.md]]",
      "<!-- citations:end -->",
      "",
    ].join("\n");
    const fs = new MemFs({ "wiki/concepts/T.md": `---\nkind: concept\n---\n${body}` });

    const citations = await readCitations(fs, [page("T")].map((p) => ({
      ...p,
      path: "wiki/concepts/T.md",
    })));
    expect(citations.get("wiki/concepts/T.md")).toEqual(["raw/a.md", "raw/b.md"]);
  });

  it("gives a page with no block an empty record", async () => {
    const fs = new MemFs({ "wiki/concepts/T.md": "---\nkind: concept\n---\nProse.\n" });
    const citations = await readCitations(fs, [{ ...page("T"), path: "wiki/concepts/T.md" }]);
    expect(citations.get("wiki/concepts/T.md")).toEqual([]);
  });
});

describe("renderPage (invariant 5: code writes the structure)", () => {
  const concept: PageToWrite = {
    path: "wiki/concepts/Personalized PageRank.md",
    title: "Personalized PageRank",
    kind: "concept",
    aliases: ["PPR"],
    summary: "Ranking by random walk.",
    body: "Luka ranks with [[PPR]].",
    citers: ["raw/paper.md"],
  };

  it("composes frontmatter, the resolved body, and the citation block", () => {
    const index = buildTitleIndex([page("Personalized PageRank", ["PPR"])]);
    const rendered = renderPage(concept, index, "2026-08-20");

    expect(rendered).toBe(
      [
        "---",
        "kind: concept",
        "aliases:",
        "  - PPR",
        "summary: Ranking by random walk.",
        "updated: '2026-08-20'",
        "---",
        "Luka ranks with [[Personalized PageRank|PPR]].",
        "",
        "<!-- citations:start -->",
        "## Sources",
        "- [[raw/paper.md]]",
        "<!-- citations:end -->",
        "",
      ].join("\n"),
    );
  });

  it("adds §4's source key on a source page and nowhere else", () => {
    const sourcePage: PageToWrite = {
      ...concept,
      kind: "source",
      body: "A summary of the paper.",
      sourcePath: "raw/paper.md",
    };
    expect(renderPage(sourcePage, EMPTY_INDEX, "2026-08-20")).toContain(
      "source: '[[raw/paper.md]]'",
    );
    expect(renderPage(concept, EMPTY_INDEX, "2026-08-20")).not.toContain("source:");
  });

  it("has a source page cite its own raw file (§4)", () => {
    const sourcePage: PageToWrite = {
      ...concept,
      kind: "source",
      body: "A summary.",
      citers: ["raw/paper.md"],
      sourcePath: "raw/paper.md",
    };
    expect(parseCitationBlock(renderPage(sourcePage, EMPTY_INDEX, "2026-08-20")).entries).toEqual([
      "raw/paper.md",
    ]);
  });

  it("discards a citation block the model wrote instead of stacking a second", () => {
    const withBlock: PageToWrite = {
      ...concept,
      body: [
        "Real prose.",
        "",
        "<!-- citations:start -->",
        "## Sources",
        "- [[raw/hallucinated.md]]",
        "<!-- citations:end -->",
      ].join("\n"),
    };

    const rendered = renderPage(withBlock, EMPTY_INDEX, "2026-08-20");
    expect(rendered.match(/citations:start/g)).toHaveLength(1);
    expect(parseCitationBlock(rendered).entries).toEqual(["raw/paper.md"]);
  });

  it("round-trips citer paths containing characters that are legal in filenames", () => {
    // `[`, `]`, `|`, `#` and spaces are all legal on macOS and Linux, and the
    // citation block is the only record of a page's citers (§6.5). A path that
    // does not survive render→parse is a source silently lost on the next run.
    const awkward = [
      "raw/[draft] notes.md",
      "raw/a|b.md",
      "raw/chapter #3.md",
      "raw/Ångström & 北京.md",
    ];
    const rendered = renderPage({ ...concept, citers: awkward }, EMPTY_INDEX, "2026-08-20");

    expect(parseCitationBlock(rendered).entries).toEqual(awkward);
  });

  it("carries an awkward source path into the Call B prompt intact", () => {
    const prompt = renderCallBPrompt({
      title: "T",
      kind: "concept",
      aliases: [],
      sources: [{ path: "raw/[draft] a|b #1.md", body: "Body." }],
      contextBudgetTokens: 40_000,
    });
    expect(prompt).toContain("--- source: raw/[draft] a|b #1.md ---");
  });

  it("is byte-identical when regenerated from the same model reply", () => {
    const index = buildTitleIndex([page("Personalized PageRank", ["PPR"])]);
    const once = renderPage(concept, index, "2026-08-20");
    const twice = renderPage({ ...concept, body: once }, index, "2026-08-20");
    // Re-rendering the finished page reproduces it: links stay resolved and the
    // block is replaced rather than duplicated.
    expect(twice).toContain("<!-- citations:start -->");
    expect(twice.match(/citations:start/g)).toHaveLength(1);
    expect(renderPage(concept, index, "2026-08-20")).toBe(once);
  });
});

describe("readablePathFor (§7.1)", () => {
  it("is the source itself for passthrough formats", () => {
    expect(readablePathFor("raw/note.md", "md", null)).toBe("raw/note.md");
    expect(readablePathFor("raw/notes.txt", "txt", null)).toBe("raw/notes.txt");
  });

  it("is the derivative for every converting format", () => {
    expect(readablePathFor("raw/paper.pdf", "pdf", "raw/paper.md")).toBe("raw/paper.md");
    expect(readablePathFor("raw/board.png", "image", "raw/board.md")).toBe("raw/board.md");
    expect(readablePathFor("raw/toy-repo", "repo", "raw/toy-repo.md")).toBe("raw/toy-repo.md");
  });
});
