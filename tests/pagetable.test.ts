import { describe, expect, it } from "vitest";
import {
  loadPageTable,
  pagePathForKind,
  sanitizeTitle,
  takenTitles,
  uniqueTitle,
} from "../src/core/compile/pagetable";
import { MemFs } from "./helpers/memfs";

function wikiPage(kind: string, extra = ""): string {
  return `---\nkind: ${kind}\nsummary: A summary.\nupdated: '2026-08-20'\n${extra}---\nBody.\n`;
}

describe("loadPageTable", () => {
  it("builds the table from wiki frontmatter, taking the title from the filename", async () => {
    const fs = new MemFs({
      "wiki/sources/Paper Title.md": wikiPage("source"),
      "wiki/entities/Ada Lovelace.md": wikiPage("entity", "aliases:\n  - Ada\n  - Lovelace\n"),
      "wiki/concepts/PageRank.md": wikiPage("concept"),
    });

    // Ordered by path: concepts/, then entities/, then sources/.
    const pages = await loadPageTable(fs);
    expect(pages.map((p) => p.title)).toEqual(["PageRank", "Ada Lovelace", "Paper Title"]);
    expect(pages.map((p) => p.kind)).toEqual(["concept", "entity", "source"]);
    expect(pages.find((p) => p.title === "Ada Lovelace")?.aliases).toEqual(["Ada", "Lovelace"]);
    expect(pages[0]?.summary).toBe("A summary.");
  });

  it("never includes _-prefixed infrastructure files (invariant 8)", async () => {
    const fs = new MemFs({
      "wiki/_index.md": wikiPage("concept"),
      "wiki/_health.md": wikiPage("concept"),
      "wiki/concepts/Real.md": wikiPage("concept"),
    });
    expect((await loadPageTable(fs)).map((p) => p.title)).toEqual(["Real"]);
  });

  it("never descends into a _-prefixed folder", async () => {
    const fs = new MemFs({
      "wiki/_drafts/Hidden Draft.md": wikiPage("concept"),
      "wiki/_templates/Tpl.md": wikiPage("entity"),
      "wiki/concepts/Real.md": wikiPage("concept"),
    });
    expect((await loadPageTable(fs)).map((p) => p.title)).toEqual(["Real"]);
  });

  it("skips files without a recognizable kind", async () => {
    const fs = new MemFs({
      "wiki/concepts/Good.md": wikiPage("concept"),
      "wiki/concepts/NoFrontmatter.md": "Just prose.\n",
      "wiki/concepts/BadKind.md": wikiPage("answer"),
    });
    expect((await loadPageTable(fs)).map((p) => p.title)).toEqual(["Good"]);
  });

  it("skips a non-markdown file even when its frontmatter looks like a page", async () => {
    const fs = new MemFs({
      "wiki/concepts/Good.md": wikiPage("concept"),
      "wiki/notes.txt": wikiPage("concept"),
    });
    expect((await loadPageTable(fs)).map((p) => p.title)).toEqual(["Good"]);
  });

  it("reads the frontmatter shapes a hand-written vault produces", async () => {
    const fs = new MemFs({
      "wiki/entities/Bare String.md": `---\nkind: entity\naliases: Ada\n---\nBody.\n`,
      "wiki/entities/Junk List.md": `---\nkind: entity\naliases:\n  - 42\n  - ''\n  - '  Real  '\n---\nBody.\n`,
      "wiki/entities/No Summary.md": `---\nkind: entity\nupdated: '2026-08-20'\n---\nBody.\n`,
    });
    const pages = await loadPageTable(fs);
    const byTitle = new Map(pages.map((p) => [p.title, p]));

    expect(byTitle.get("Bare String")?.aliases).toEqual(["Ada"]);
    expect(byTitle.get("Junk List")?.aliases).toEqual(["Real"]);
    expect(byTitle.get("No Summary")?.summary).toBe("");
    expect(byTitle.get("No Summary")?.updated).toBe("2026-08-20");
  });

  it("returns an empty table when wiki/ does not exist yet", async () => {
    await expect(loadPageTable(new MemFs())).resolves.toEqual([]);
  });

  it("orders deterministically by path", async () => {
    const fs = new MemFs({
      "wiki/concepts/Zebra.md": wikiPage("concept"),
      "wiki/concepts/Apple.md": wikiPage("concept"),
      "wiki/entities/Middle.md": wikiPage("entity"),
    });
    expect((await loadPageTable(fs)).map((p) => p.path)).toEqual([
      "wiki/concepts/Apple.md",
      "wiki/concepts/Zebra.md",
      "wiki/entities/Middle.md",
    ]);
  });
});

describe("sanitizeTitle", () => {
  it("strips exactly the forbidden characters", () => {
    expect(sanitizeTitle("A[b]c#d^e|f\\g/h:i")).toBe("Abcdefghi");
  });

  it("strips leading underscores and dots so no page can look like infrastructure", () => {
    expect(sanitizeTitle("_index")).toBe("index");
    expect(sanitizeTitle("...hidden")).toBe("hidden");
    expect(sanitizeTitle("__._mixed")).toBe("mixed");
  });

  it("keeps underscores and dots that are not leading", () => {
    expect(sanitizeTitle("snake_case v1.2")).toBe("snake_case v1.2");
  });

  it("collapses internal whitespace and trims", () => {
    expect(sanitizeTitle("  Too   many    spaces  ")).toBe("Too many spaces");
  });

  it("falls back to Untitled when nothing survives", () => {
    expect(sanitizeTitle("///")).toBe("Untitled");
    expect(sanitizeTitle("   ")).toBe("Untitled");
    expect(sanitizeTitle("___")).toBe("Untitled");
  });

  it("leaves an ordinary qualified title intact", () => {
    expect(sanitizeTitle("Mercury (element)")).toBe("Mercury (element)");
  });
});

describe("uniqueTitle (unique across wiki/)", () => {
  it("returns the title unchanged when free", () => {
    expect(uniqueTitle("Fresh", new Set())).toBe("Fresh");
  });

  it("suffixes -2, then -3, on collision", () => {
    const taken = new Set(["taken"]);
    expect(uniqueTitle("Taken", taken)).toBe("Taken-2");
    taken.add("taken-2");
    expect(uniqueTitle("Taken", taken)).toBe("Taken-3");
  });

  it("compares case-insensitively, since the vault may be case-insensitive", () => {
    expect(uniqueTitle("Mercury", new Set(["mercury"]))).toBe("Mercury-2");
  });

  it("builds its taken-set from an existing table", () => {
    const taken = takenTitles([
      { path: "wiki/concepts/A.md", title: "A", kind: "concept", aliases: [], summary: "", updated: "" },
    ]);
    expect(uniqueTitle("a", taken)).toBe("a-2");
  });
});

describe("pagePathForKind", () => {
  it("files each kind under its folder", () => {
    expect(pagePathForKind("Paper", "source")).toBe("wiki/sources/Paper.md");
    expect(pagePathForKind("Ada", "entity")).toBe("wiki/entities/Ada.md");
    expect(pagePathForKind("PageRank", "concept")).toBe("wiki/concepts/PageRank.md");
  });
});
