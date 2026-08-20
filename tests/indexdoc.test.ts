import { describe, expect, it } from "vitest";
import { withCitationBlock } from "../src/core/compile/citations";
import { INDEX_PATH, renderIndex } from "../src/core/compile/indexdoc";
import { buildTitleIndex, resolveLinks } from "../src/core/compile/links";
import type { PageMeta } from "../src/core/types";

function page(
  title: string,
  kind: PageMeta["kind"],
  summary = "",
  aliases: string[] = [],
): PageMeta {
  return { path: `wiki/${title}.md`, title, kind, aliases, summary, updated: "2026-08-20" };
}

describe("renderIndex (§4)", () => {
  it("matches the §4 sample byte for byte", () => {
    const rendered = renderIndex([page("Paper Title", "source", "one-line summary", ["a", "b"])]);
    expect(rendered).toBe(
      [
        "# Index",
        "## Sources",
        "- [[Paper Title]] — one-line summary (aliases: a, b)",
        "## Entities",
        "## Concepts",
        "",
      ].join("\n"),
    );
  });

  it("keeps the three headings in §4's order even when sections are empty", () => {
    expect(renderIndex([])).toBe("# Index\n## Sources\n## Entities\n## Concepts\n");
  });

  it("omits the aliases suffix when a page has none", () => {
    expect(renderIndex([page("Solo", "concept", "just a summary")])).toContain(
      "- [[Solo]] — just a summary\n",
    );
  });

  it("omits the summary dash when there is no summary", () => {
    const line = renderIndex([page("Bare", "entity")]).split("\n")[3];
    expect(line).toBe("- [[Bare]]");
  });

  it("sorts entries within each section by title, deterministically", () => {
    const rendered = renderIndex([
      page("Zebra", "concept"),
      page("apple", "concept"),
      page("Banana", "concept"),
    ]);
    // Code-point order, so capitals precede lowercase — deterministic across locales.
    expect(rendered.split("\n").slice(4, 7)).toEqual(["- [[Banana]]", "- [[Zebra]]", "- [[apple]]"]);
  });

  it("routes each page to the section matching its kind", () => {
    const rendered = renderIndex([
      page("C", "concept"),
      page("S", "source"),
      page("E", "entity"),
    ]);
    expect(rendered).toBe(
      "# Index\n## Sources\n- [[S]]\n## Entities\n- [[E]]\n## Concepts\n- [[C]]\n",
    );
  });

  it("lives at the §4 path, which is infrastructure", () => {
    expect(INDEX_PATH).toBe("wiki/_index.md");
  });

  it("trims summaries and drops blank aliases", () => {
    const rendered = renderIndex([page("A", "concept", "  padded  ", ["  x  ", "", "  "])]);
    expect(rendered).toContain("- [[A]] — padded (aliases: x)\n");
  });

  it("keeps a model-written summary from injecting index structure (invariant 5)", () => {
    const rendered = renderIndex([
      page("Real", "source", "A summary.\n## Concepts\n- [[Fake Page]] — injected"),
      page("Alias Attack", "entity", "fine", ["ok", "bad\n- [[Ghost]]"]),
    ]);

    // The words survive as prose inside their own entry — that is the model's
    // summary. What must not survive is the *structure*: no injected heading,
    // no phantom entry, one line per page.
    expect(rendered.match(/^## Concepts$/gm)).toHaveLength(1);
    expect(rendered.match(/^- \[\[/gm)).toHaveLength(2);
    expect(rendered.trimEnd().split("\n")).toHaveLength(6);
  });
});

describe("the code-written page, end to end (invariant 5)", () => {
  it("composes post-pass and citation block into the exact final bytes", () => {
    const table = [
      page("Personalized PageRank", "concept", "Ranking by random walk.", ["PPR"]),
      page("Obsidian", "entity", "The editor."),
    ];
    const index = buildTitleIndex(table);

    // What the model would have returned: prose with wikilinks and nothing else.
    const modelBody = "Luka ranks with [[PPR]] inside [[Obsidian]], not [[Faiss]].";

    const linked = resolveLinks(modelBody, index);
    const finished = withCitationBlock(linked, ["raw/paper.md", "raw/notes.md"]);

    expect(finished).toBe(
      [
        "Luka ranks with [[Personalized PageRank|PPR]] inside [[Obsidian]], not [[Faiss]].",
        "",
        "<!-- citations:start -->",
        "## Sources",
        "- [[raw/paper.md]]",
        "- [[raw/notes.md]]",
        "<!-- citations:end -->",
        "",
      ].join("\n"),
    );
  });

  it("regenerates to identical bytes on a second pass over the finished page", () => {
    const index = buildTitleIndex([page("Alpha", "concept", "", ["A"])]);
    const first = withCitationBlock(resolveLinks("Mentions [[A]].", index), ["raw/a.md"]);
    const second = withCitationBlock(resolveLinks(first, index), ["raw/a.md"]);
    expect(second).toBe(first);
  });
});
