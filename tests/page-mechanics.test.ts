import { describe, expect, it } from "vitest";
import { createCore } from "../src/core/index";
import { DEFAULT_SETTINGS } from "../src/core/types";
import { mergeInventories } from "../src/core/compile/dedup";
import { generatePageBody } from "../src/core/compile/generate";
import { buildTitleIndex, resolveLinks } from "../src/core/compile/links";
import {
  handleOf,
  sanitizeTitle,
  takenTitles,
  titleStem,
  uniqueTitle,
} from "../src/core/compile/pagetable";
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

    // `reported`, not `failed`: the index is re-derived from the page table
    // every compile, so nothing is owed and nothing is retried — which is
    // exactly what separates the two buckets. Filed under `failed` the user is
    // told a file was "skipped" that is neither a source nor a page.
    expect(result.reported.map((f) => f.path)).toContain("wiki/_index.md");
    expect(result.failed).toEqual([]);
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
    const bytes = new TextEncoder().encode(title).length;

    // Pins the bound itself, not just the host's 255: an assertion that only
    // says "under 255" passes unchanged under the old 120-code-unit cap.
    expect(bytes).toBeLessThanOrEqual(200);
    expect(bytes).toBeGreaterThan(190);
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

describe("a page names every source the model did not fully receive", () => {
  const source = (path: string, body: string) => ({ path, body });
  const input = (contextBudgetTokens: number) => ({
    title: "PageRank",
    kind: "concept" as const,
    aliases: [],
    sources: [source("raw/one.md", "ONE ".repeat(60)), source("raw/two.md", "TWO ".repeat(60))],
    contextBudgetTokens,
  });

  it("names a source that was truncated, not only ones that were dropped", async () => {
    // §7.4 truncates the first item rather than dropping it, so it stays in
    // the packed set while the model saw only part of it. A page that names
    // only the dropped ones implies the first arrived whole.
    const body = await generatePageBody(
      { complete: async () => "PROSE", stats: () => ({ requests: 0, byTask: {} }) } as never,
      input(20),
    );

    expect(body).toContain("raw/one.md");
    expect(body).toContain("raw/two.md");
  });

  it("puts the names inside the comment, like every other marker", async () => {
    const body = await generatePageBody(
      { complete: async () => "PROSE", stats: () => ({ requests: 0, byTask: {} }) } as never,
      input(20),
    );

    const stripped = body.replace(/<!--[\s\S]*?-->/g, "");
    expect(stripped).not.toContain("raw/one.md");
    expect(stripped).not.toContain("raw/two.md");
  });

  it("says nothing when every source fitted whole", async () => {
    const body = await generatePageBody(
      { complete: async () => "PROSE", stats: () => ({ requests: 0, byTask: {} }) } as never,
      input(40_000),
    );

    expect(body).toBe("PROSE");
  });
});

describe("a source with no body is not grounding", () => {
  it("names a citer whose file is empty, though it fitted the budget", async () => {
    // §6.5 writes the citation block from the full citer set, so an empty file
    // is the same false claim as a dropped one by a different route: the model
    // received a header with nothing under it.
    const body = await generatePageBody(
      { complete: async () => "PROSE", stats: () => ({ requests: 0, byTask: {} }) } as never,
      {
        title: "PageRank",
        kind: "concept" as const,
        aliases: [],
        sources: [
          { path: "raw/empty.md", body: "" },
          { path: "raw/real.md", body: "Real content." },
        ],
        contextBudgetTokens: 40_000,
      },
    );

    expect(body).toContain("raw/empty.md");
    expect(body).not.toContain("raw/real.md");
  });
});

describe("a page whose title was cut can still be found again", () => {
  // §4 stores a page's title only as its filename, so a cut is the one place
  // the namespace can lose identity. The stored key and the lookup key have to
  // be the same rule — a name free in one table and taken in another is the
  // defect handleOf exists to prevent, one axis over.
  const long = (tail: string) => `${"A".repeat(260)} ${tail}`;

  const compileOnce = (existing: PageMeta[], title: string) =>
    mergeInventories(existing, [{ sourcePath: "raw/a.md", items: [item(title)] }]);

  it("re-matches its own page instead of creating another every compile", () => {
    const first = compileOnce([], long("Zebra"));
    const created = first.newPages[0] as { title: string };
    const stored: PageMeta = {
      path: `wiki/concepts/${created.title}.md`,
      title: created.title,
      kind: "concept",
      aliases: [],
      summary: "",
      updated: "",
    };

    const second = compileOnce([stored], long("Zebra"));

    expect(second.newPages).toEqual([]);
    expect(second.regenerate.map((r) => r.page.title)).toEqual([created.title]);
  });

  it("still keeps two different long titles apart", () => {
    const zebra = (compileOnce([], long("Zebra")).newPages[0] as { title: string }).title;
    const quokka = (compileOnce([], long("Quokka")).newPages[0] as { title: string }).title;

    expect(zebra).not.toBe(quokka);
  });

  it("keeps a cut title inside the byte bound, tag and all", () => {
    const title = uniqueTitle(sanitizeTitle("\u6587".repeat(300)), new Set());
    const bytes = new TextEncoder().encode(title).length;

    // Pins the bound, not the host's 255 — the weak form passes unchanged
    // under any bound up to 252, which is how the previous two rounds shipped
    // assertions that could not fail.
    expect(bytes).toBeLessThanOrEqual(200);
    expect(bytes).toBeGreaterThan(190);
    expect(title).toMatch(/-[0-9a-z]{7}$/);
  });
});

describe("naming and lookup are inverses", () => {
  const source = (title: string): PageMeta => ({
    path: `wiki/sources/${title}.md`,
    title,
    kind: "source",
    aliases: [],
    summary: "",
    updated: "",
  });

  it("finds the page the uniqueness suffix was forced onto", () => {
    // §4 requires titles unique across all of wiki/, so a concept whose name a
    // source page already holds is named `X-2`. Nothing the model returns next
    // compile ever spells `X-2`, so without a lookup that inverts the suffix
    // the merge creates `X-3`, then `X-4`, for ever — one page and one Call B
    // per compile, and none of them ever loses its last citer.
    const first = mergeInventories([source("PageRank")], [
      { sourcePath: "raw/PageRank.md", items: [item("PageRank")] },
    ]);
    const named = (first.newPages[0] as { title: string }).title;
    expect(named).toBe("PageRank-2");

    const stored: PageMeta = {
      path: `wiki/concepts/${named}.md`,
      title: named,
      kind: "concept",
      aliases: [],
      summary: "",
      updated: "",
    };
    const second = mergeInventories([source("PageRank"), stored], [
      { sourcePath: "raw/PageRank.md", items: [item("PageRank")] },
    ]);

    expect(second.newPages).toEqual([]);
    expect(second.regenerate.map((r) => r.page.title)).toEqual(["PageRank-2"]);
  });

  it("does not read a number in a title as a uniqueness suffix", () => {
    // "Q3-2024" is a title, not "Q3" plus a suffix. The inverse only applies
    // to a base some page actually holds — which is what forced the suffix.
    const work = mergeInventories(
      [{ ...source("Q3-2024"), kind: "concept", path: "wiki/concepts/Q3-2024.md" }],
      [{ sourcePath: "raw/a.md", items: [item("Q3")] }],
    );

    expect(work.newPages.map((p) => p.title)).toEqual(["Q3"]);
  });

  it("gives one page to two spellings §4 calls one name", () => {
    // handleOf folds case; the stem's tag must fold it too, or a long title
    // re-emitted in another casing takes a second permanent page.
    const a = `${"Q".repeat(250)} Zebra`;
    const b = `${"Q".repeat(250)} zebra`;

    expect(handleOf(titleStem(a))).toBe(handleOf(titleStem(b)));
  });
});

describe("the two lookups are one rule", () => {
  it("merges two long titles that differ only where sanitizeTitle strips", () => {
    // `newIndex` keys the bounded handle and the raw handle, never the
    // unbounded sanitized one — so for a title long enough to be cut, this is
    // the only candidate that can match, and both items are one concept.
    const base = "A".repeat(300);
    const work = mergeInventories([], [
      { sourcePath: "raw/a.md", items: [item(`${base}#B`), item(`${base}B`)] },
    ]);

    expect(work.newPages).toHaveLength(1);
  });

  it("finds a page whose base is a source page named earlier in the same run", () => {
    // The namer's `claimed` is pages ∪ reserved; the lookup's `held` has to be
    // the same set, or a source page named this run is invisible to it and the
    // concept takes a second name it will keep for ever.
    const stored: PageMeta = {
      path: "wiki/concepts/PageRank-2.md",
      title: "PageRank-2",
      kind: "concept",
      aliases: [],
      summary: "",
      updated: "",
    };
    const work = mergeInventories(
      [stored],
      [{ sourcePath: "raw/a.md", items: [item("PageRank")] }],
      [],
      new Set(["PageRank"]),
    );

    expect(work.newPages).toEqual([]);
    expect(work.regenerate.map((r) => r.page.title)).toEqual(["PageRank-2"]);
  });

  it("prefers the lowest suffix regardless of the order pages arrive in", () => {
    const page = (title: string): PageMeta => ({
      path: `wiki/concepts/${title}.md`,
      title,
      kind: "concept",
      aliases: [],
      summary: "",
      updated: "",
    });
    const source: PageMeta = {
      path: "wiki/sources/X.md",
      title: "X",
      kind: "source",
      aliases: [],
      summary: "",
      updated: "",
    };
    const entry = [{ sourcePath: "raw/a.md", items: [item("X")] }];

    const forward = mergeInventories([source, page("X-2"), page("X-10")], entry);
    const reversed = mergeInventories([page("X-10"), page("X-2"), source], entry);

    expect(forward.regenerate.map((r) => r.page.title)).toEqual(["X-2"]);
    expect(reversed.regenerate.map((r) => r.page.title)).toEqual(["X-2"]);
  });
});
