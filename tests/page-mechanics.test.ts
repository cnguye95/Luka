import { describe, expect, it } from "vitest";
import { createCore } from "../src/core/index";
import { DEFAULT_SETTINGS } from "../src/core/types";
import { mergeInventories } from "../src/core/compile/dedup";
import { buildTitleIndex, resolveLinks } from "../src/core/compile/links";
import { sanitizeTitle, takenTitles, uniqueTitle } from "../src/core/compile/pagetable";
import type { PageMeta } from "../src/core/types";
import { StubHttp } from "./helpers/http";
import { MemFs } from "./helpers/memfs";
import { StubProvider, inventoryReply } from "./helpers/provider";

const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";

function page(title: string, aliases: string[] = []): PageMeta {
  return {
    path: `wiki/concepts/${title}.md`,
    title,
    kind: "concept",
    aliases,
    summary: "",
    updated: "",
  };
}

const item = (title: string, aliases: string[] = []) => ({
  title,
  kind: "concept" as const,
  aliases,
  summary: "",
});

describe("an alias belongs to one page", () => {
  it("is not adopted when it is another page's title", () => {
    // §4 gives titles and aliases one namespace, and the link post-pass
    // resolves a handle to exactly one page. Handing Beta the alias "Alpha"
    // writes a claim into frontmatter that every [[Alpha]] link contradicts.
    const work = mergeInventories(
      [page("Alpha"), page("Beta")],
      [{ sourcePath: "raw/a.md", items: [item("Beta", ["Alpha"])] }],
    );
    const beta = work.regenerate.find((r) => r.page.title === "Beta");
    expect(beta?.newAliases ?? []).not.toContain("Alpha");
  });

  it("is not stolen from the page that already carries it", () => {
    const work = mergeInventories(
      [page("Alpha", ["Zed"]), page("Beta")],
      [{ sourcePath: "raw/a.md", items: [item("Beta", ["Zed"])] }],
    );
    const beta = work.regenerate.find((r) => r.page.title === "Beta");
    expect(beta?.newAliases ?? []).not.toContain("Zed");
  });

  it("is not claimed by two new pages in one run", () => {
    const work = mergeInventories(
      [],
      [
        {
          sourcePath: "raw/a.md",
          // Beta is created first with no alias, then a second mention tries to
          // bring "Zed" across — the path that actually reaches the merge.
          items: [item("Alpha", ["Zed"]), item("Beta"), item("Beta", ["Zed"])],
        },
      ],
    );
    const holders = work.newPages.filter((p) =>
      p.aliases.some((a) => a.toLowerCase() === "zed"),
    );
    expect(holders).toHaveLength(1);
  });

  it("still lets a page keep the aliases that are genuinely its own", () => {
    const work = mergeInventories(
      [page("Alpha")],
      [{ sourcePath: "raw/a.md", items: [item("Alpha", ["Al", "A1"])] }],
    );
    const alpha = work.regenerate.find((r) => r.page.title === "Alpha");
    expect(alpha?.newAliases).toEqual(["Al", "A1"]);
  });
});

describe("a title the filesystem will refuse never reaches the write", () => {
  it("strips the characters no common filesystem accepts", () => {
    for (const [raw, forbidden] of [
      ["What? Why*", "?"],
      ['quote"x', '"'],
      ["a<b>c", "<"],
      ["a\u0000b", "\u0000"],
    ] as const) {
      expect(sanitizeTitle(raw)).not.toContain(forbidden);
      expect(sanitizeTitle(raw)).not.toBe("");
    }
  });

  it("leaves length alone, because §6.5 matches through this function", () => {
    expect(sanitizeTitle("x".repeat(400))).toBe("x".repeat(400));
  });

  it("folds a title to one Unicode form, so two spellings are one page", () => {
    // NFC and NFD are different strings but the same path on APFS, so without
    // this two pages collapse into one file and one loses its content.
    const nfc = "Café";
    const nfd = "Café";
    expect(sanitizeTitle(nfc)).toBe(sanitizeTitle(nfd));
  });
});

describe("the index write cannot discard the run", () => {
  it("reports a failure and still commits the manifest", async () => {
    const fs = new MemFs({ "raw/note.md": "PageRank matters.\n" });
    const guarded = Object.create(fs) as MemFs;
    guarded.write = async (path: string, data: string | Uint8Array): Promise<void> => {
      if (path === "wiki/_index.md") throw new Error("EACCES");
      return MemFs.prototype.write.call(fs, path, data);
    };

    const core = createCore({
      fs: guarded,
      http: new StubHttp({}),
      manifestPath: MANIFEST,
      settings: { ...DEFAULT_SETTINGS, apiKey: "test-key" },
      now: () => new Date("2026-08-19T10:00:00Z"),
      provider: new StubProvider((request: { task: string }) =>
        request.task === "page-generation"
          ? "Body.\n"
          : inventoryReply("A source.", [{ title: "PageRank", kind: "concept" }]),
      ),
    });

    // It must not throw: the model calls are already spent and the pages are
    // already on disk.
    const result = await core.compile();

    expect(result.failed.map((f) => f.path)).toContain("wiki/_index.md");
    // The manifest still commits, so the next run does not re-spend the calls.
    expect(fs.files.has(MANIFEST)).toBe(true);

    const second = await createCore({
      fs,
      http: new StubHttp({}),
      manifestPath: MANIFEST,
      settings: { ...DEFAULT_SETTINGS, apiKey: "test-key" },
      now: () => new Date("2026-08-19T10:00:00Z"),
      provider: new StubProvider(() => "Body.\n"),
    }).compile();
    expect(second.modelCalls).toBe(0);
  });
});

describe("a page says when a citer was left out of its own generation", () => {
  it("marks the page, not just the prompt", async () => {
    // The budget marker reaches the model but never the reader, so the citation
    // block claims a source the page was not grounded in — and §6.5 makes that
    // block the persistent citer record.
    const big = (word: string) => `${word} `.repeat(30_000);
    const fs = new MemFs({
      "raw/a.md": `PageRank. ${big("alpha")}`,
      "raw/b.md": `PageRank. ${big("beta")}`,
    });

    const result = await createCore({
      fs,
      http: new StubHttp({}),
      manifestPath: MANIFEST,
      settings: { ...DEFAULT_SETTINGS, apiKey: "test-key" },
      now: () => new Date("2026-08-19T10:00:00Z"),
      provider: new StubProvider((request: { task: string }) =>
        request.task === "page-generation"
          ? "Body.\n"
          : inventoryReply("A source.", [{ title: "PageRank", kind: "concept" }]),
      ),
    }).compile();

    expect(result.failed).toEqual([]);
    const text = fs.text("wiki/concepts/PageRank.md");
    // Both are cited...
    expect(text).toContain("raw/a.md");
    expect(text).toContain("raw/b.md");
    // ...so the page has to admit one of them did not reach the model.
    expect(text).toMatch(/<!-- .*budget.* -->/);
  });
});

// §4 gives titles and aliases one namespace. A namespace needs one spelling
// rule: every table keyed by a handle — the page table, the link index, the
// owner map, the dedup index — has to agree on what makes two strings the
// same handle, or a name is free in one table and taken in another.
describe("a handle has one canonical form", () => {
  const NFC = "Caf\u00e9";
  const NFD = "Cafe\u0301";

  it("does not create a second page for a title already on disk in another form", () => {
    // The two spell one filename on APFS. A second page here is the write
    // that destroys the first, which is the whole reason titles are folded.
    const work = mergeInventories([page(NFD)], [{ sourcePath: "raw/a.md", items: [item(NFC)] }]);

    expect(work.newPages).toEqual([]);
    expect(work.regenerate.map((r) => r.page.title)).toEqual([NFD]);
  });

  it("does not hand a second page an alias another page holds in another form", () => {
    // The item matches "Coffee House" by title, then offers as an alias the
    // other spelling of a name the Café page already holds.
    const work = mergeInventories(
      [page(NFC), page("Coffee House")],
      [{ sourcePath: "raw/a.md", items: [item("Coffee House", [NFD])] }],
    );

    expect(work.regenerate.find((r) => r.page.title === "Coffee House")?.newAliases).toEqual([]);
  });

  it("counts a title as taken whichever form it is spelled in", () => {
    expect(uniqueTitle(NFC, takenTitles([page(NFD)]))).toBe(`${NFC}-2`);
  });

  it("resolves a link written in either form to the one page", () => {
    const index = buildTitleIndex([page(NFC)]);

    expect(resolveLinks(`[[${NFD}]]`, index)).toBe(`[[${NFC}|${NFD}]]`);
  });

  it("refuses a reserved title whatever case it was reserved in", () => {
    // `reserved` holds names this run handed out before the merge — the
    // source pages. The guard cannot depend on the caller's casing.
    const work = mergeInventories(
      [],
      [{ sourcePath: "raw/a.md", items: [item("Thing", ["Paper Title"])] }],
      [],
      new Set(["Paper Title"]),
    );

    expect(work.newPages[0]?.aliases).toEqual([]);
  });
});

describe("the length bound is a filename rule, not a matching rule", () => {
  it("does not merge two distinct titles that share a long prefix", () => {
    // §6.5 dedups on "each item's title and aliases". A prefix is not a title,
    // so bounding the matching key merges concepts that share an opening.
    const prefix = "A".repeat(130);
    const work = mergeInventories(
      [],
      [
        {
          sourcePath: "raw/a.md",
          items: [item(`${prefix} Zebra genome`), item(`${prefix} Quokka census`)],
        },
      ],
    );

    expect(work.newPages).toHaveLength(2);
  });

  it("bounds the filename in bytes, because that is what the limit counts", () => {
    const title = uniqueTitle(sanitizeTitle("\u6587".repeat(300)), new Set());

    expect(new TextEncoder().encode(`${title}.md`).length).toBeLessThanOrEqual(255);
  });

  it("never cuts between the halves of a surrogate pair", () => {
    // A lone surrogate encodes as U+FFFD, so the name on disk and the title in
    // memory stop being the same string and every table keyed by it splits.
    const title = uniqueTitle(sanitizeTitle("a".repeat(119) + "\u{1F600}".repeat(50)), new Set());

    expect(/[\uD800-\uDBFF]$/.test(title)).toBe(false);
    expect(title).toBe([...title].join(""));
  });

  it("keeps the suffix inside the bound too", () => {
    const long = sanitizeTitle("\u6587".repeat(300));
    const title = uniqueTitle(long, takenTitles([page(uniqueTitle(long, new Set()))]));

    expect(title).toMatch(/-2$/);
    expect(new TextEncoder().encode(`${title}.md`).length).toBeLessThanOrEqual(255);
  });
});
