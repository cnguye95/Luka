// M2c end to end: discover → normalize → Call A → merge → Call B → post-process
// → index, over an in-memory vault with a stub provider at the wrapper layer.
//
// The call-count assertions here are invariant 12's: "compile = S inventory
// calls + P page-generation calls (+1 vision call per orphan image)".
import { describe, expect, it } from "vitest";
import { parseCitationBlock } from "../src/core/compile/citations";
import { loadPageTable } from "../src/core/compile/pagetable";
import { createCore, type CompileResult, type CoreDeps } from "../src/core/index";
import { MAX_TOKENS_BY_TASK, type CompletionRequest } from "../src/core/provider/types";
import { DEFAULT_SETTINGS } from "../src/core/types";
import { StubHttp } from "./helpers/http";
import { MemFs } from "./helpers/memfs";
import { StubProvider, fatalError, inventoryReply, retryableError } from "./helpers/provider";

const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";

/** A 1×1 PNG — enough for format detection; the stub never decodes it. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
]);

/** Inventories keyed by a phrase in the source body, so replies are stable. */
function replyFor(request: CompletionRequest): unknown {
  if (request.task === "vision") {
    return "A whiteboard covered in notes about [[Graph Retrieval]].";
  }
  if (request.task === "page-generation") {
    const title = /Title: (.+)/.exec(request.user)?.[1] ?? "?";
    // The reply names an ALIAS of a page created in this same run. An exact
    // title would round-trip unchanged whether or not same-run pages are in
    // the title index, so only an alias can prove the post-pass resolved it.
    // It also echoes the source paths the prompt carried, so a test can check
    // that the right bodies actually reached the model.
    const seen = [...request.user.matchAll(/--- source: (.+?) ---/g)].map((m) => m[1]);
    return `${title} relates to [[PPR]] and [[Obsidian]]. Saw ${seen.length}: ${seen.join(" ")}`;
  }
  if (request.user.includes("PageRank")) {
    return inventoryReply("A note about ranking.", [
      { title: "Personalized PageRank", kind: "concept", aliases: ["PPR"], summary: "A walk." },
      { title: "Obsidian", kind: "entity", aliases: [], summary: "The editor." },
    ]);
  }
  if (request.user.includes("whiteboard")) {
    return inventoryReply("A photo of a whiteboard.", [
      { title: "Graph Retrieval", kind: "concept", aliases: [], summary: "Retrieval by graph." },
    ]);
  }
  return inventoryReply("An unremarkable source.");
}

function vault(): MemFs {
  return new MemFs({
    "raw/note.md": "# Ranking\n\nPageRank ranks pages. Obsidian renders them.\n",
    "raw/plain.txt": "Nothing much here.\n",
    "raw/board.png": PNG,
  });
}

function core(fs: MemFs, provider: StubProvider, overrides: Partial<CoreDeps> = {}) {
  return createCore({
    fs,
    http: new StubHttp({}),
    manifestPath: MANIFEST,
    settings: { ...DEFAULT_SETTINGS, apiKey: "test-key" },
    now: () => new Date("2026-08-20T10:00:00Z"),
    provider,
    ...overrides,
  });
}

async function compileOnce(): Promise<{
  fs: MemFs;
  provider: StubProvider;
  result: CompileResult;
}> {
  const fs = vault();
  const provider = new StubProvider(replyFor);
  const result = await core(fs, provider).compile();
  return { fs, provider, result };
}

describe("compile, end to end (§6, invariant 12)", () => {
  it("makes exactly S inventory + P generation + 1 vision calls", async () => {
    const { provider, result } = await compileOnce();
    const stats = provider.stats();

    // Three sources: note.md, plain.txt, board.png.
    expect(stats.byTask.inventory).toBe(3);
    // One vision call for the one orphan image.
    expect(stats.byTask.vision).toBe(1);
    // Three distinct entity/concept pages were named across the inventories.
    expect(stats.byTask["page-generation"]).toBe(3);
    expect(result.modelCalls).toBe(stats.requests);
    expect(result.failed).toEqual([]);
  });

  it("produces a three-kind wiki", async () => {
    const { fs } = await compileOnce();
    const pages = await loadPageTable(fs);

    expect(pages.filter((p) => p.kind === "source")).toHaveLength(3);
    expect(pages.filter((p) => p.kind === "concept").map((p) => p.title).sort()).toEqual([
      "Graph Retrieval",
      "Personalized PageRank",
    ]);
    expect(pages.filter((p) => p.kind === "entity").map((p) => p.title)).toEqual(["Obsidian"]);
  });

  it("gives every page a valid citation block naming real sources", async () => {
    const { fs } = await compileOnce();
    const pages = await loadPageTable(fs);

    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const entries = parseCitationBlock(fs.text(page.path)).entries;
      expect(entries.length, `${page.path} has no citations`).toBeGreaterThan(0);
      for (const entry of entries) expect(await fs.exists(entry)).toBe(true);
    }
  });

  it("lists every page in _index.md (§15's M2 criterion)", async () => {
    const { fs } = await compileOnce();
    const index = fs.text("wiki/_index.md");

    for (const page of await loadPageTable(fs)) {
      expect(index, `${page.title} missing from the index`).toContain(`[[${page.title}]]`);
    }
    expect(index.startsWith("# Index\n## Sources\n")).toBe(true);
  });

  it("has each source page carry §4's source key and cite its own raw file", async () => {
    const { fs } = await compileOnce();
    const sources = (await loadPageTable(fs)).filter((page) => page.kind === "source");

    for (const page of sources) {
      expect(page.source).toBeDefined();
      expect(fs.text(page.path)).toContain(`source: '[[${page.source}]]'`);
      expect(parseCitationBlock(fs.text(page.path)).entries).toEqual([page.source]);
    }
    expect(sources.map((p) => p.source).sort()).toEqual([
      "raw/board.png",
      "raw/note.md",
      "raw/plain.txt",
    ]);
  });

  it("resolves generated links against pages written in the same run", async () => {
    const { fs } = await compileOnce();
    // The model wrote "[[PPR]]" — an alias of a page created in this very run.
    // Resolving it requires the title index to include pages not yet on disk
    // when the index was built, which is the property under test. An exact
    // title would be left untouched either way and prove nothing.
    const obsidian = fs.text("wiki/entities/Obsidian.md");
    expect(obsidian).toContain("[[Personalized PageRank|PPR]]");
    expect(obsidian).not.toContain("[[PPR]]");
  });

  it("writes the image's description as a derivative and manifests the original", async () => {
    const { fs, provider } = await compileOnce();

    expect(fs.text("raw/board.md")).toContain("derived-from: raw/board.png");
    expect(fs.text("raw/board.md")).toContain("whiteboard");
    const call = provider.callsFor("vision")[0];
    expect(call?.images[0]?.mediaType).toBe("image/png");
    expect(call?.images[0]?.bytes).toEqual(PNG);

    const manifest = JSON.parse(fs.text(MANIFEST)) as Record<string, string>;
    expect(Object.keys(manifest).sort()).toEqual(["raw/board.png", "raw/note.md", "raw/plain.txt"]);
  });

  it("keeps titles unique across wiki/ when a concept is named after a file (§4)", async () => {
    // The stem of the source file and a concept the model names are the same
    // word. Source pages and generated pages share one title space, so one of
    // them has to take a suffix — otherwise two pages answer to [[Obsidian]]
    // and the link post-pass resolves it arbitrarily.
    const fs = new MemFs({ "raw/Obsidian.md": "About the editor.\n" });
    const provider = new StubProvider((request) =>
      request.task === "inventory"
        ? inventoryReply("A note about the editor.", [{ title: "Obsidian", kind: "entity" }])
        : "Prose.",
    );

    await core(fs, provider).compile();
    const titles = (await loadPageTable(fs)).map((page) => page.title).sort();

    expect(titles).toEqual(["Obsidian", "Obsidian-2"]);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("gives two sources with the same filename stem distinct pages", async () => {
    const fs = new MemFs({
      "raw/a/note.md": "Alpha.\n",
      "raw/b/note.md": "Beta.\n",
    });
    const provider = new StubProvider((request) =>
      request.task === "inventory" ? inventoryReply("A note.") : "Prose.",
    );

    await core(fs, provider).compile();
    const pages = await loadPageTable(fs);

    expect(pages.map((page) => page.title).sort()).toEqual(["note", "note-2"]);
    expect(pages.map((page) => page.source).sort()).toEqual(["raw/a/note.md", "raw/b/note.md"]);
  });

  it("gives a source whose inventory returned no items a source page anyway (§6.5)", async () => {
    const { fs } = await compileOnce();
    const plain = (await loadPageTable(fs)).find((page) => page.source === "raw/plain.txt");
    expect(plain).toBeDefined();
    expect(plain?.summary).toBe("An unremarkable source.");
  });
});

describe("call fan-out is per page and per image, not per pair (invariant 12)", () => {
  it("generates a page cited by two sources with ONE call, not one per citer", async () => {
    const fs = new MemFs({
      "raw/one.md": "PageRank ranks pages.\n",
      "raw/two.md": "PageRank ranks pages here too.\n",
    });
    const provider = new StubProvider((request) =>
      request.task === "inventory"
        ? inventoryReply("About ranking.", [
            { title: "Personalized PageRank", kind: "concept", aliases: ["PPR"] },
          ])
        : "Prose.",
    );

    await core(fs, provider).compile();

    // Two sources, one shared page: 2 inventory calls but exactly 1 generation.
    expect(provider.stats().byTask.inventory).toBe(2);
    expect(provider.stats().byTask["page-generation"]).toBe(1);
    // And that single call was shown both citing sources (§6.5's "*all*").
    const prompt = provider.callsFor("page-generation")[0]?.user ?? "";
    expect(prompt).toContain("raw/one.md");
    expect(prompt).toContain("raw/two.md");
  });

  it("makes one vision call per orphan image, not one per compile", async () => {
    const fs = new MemFs({ "raw/one.png": PNG, "raw/two.png": PNG });
    const provider = new StubProvider((request) =>
      request.task === "vision"
        ? "A picture."
        : request.task === "inventory"
          ? inventoryReply("An image.")
          : "Prose.",
    );

    await core(fs, provider).compile();
    expect(provider.stats().byTask.vision).toBe(2);
  });
});

describe("§6.5's 'all citing sources' includes unchanged ones", () => {
  it("pulls an unchanged converted source's derivative into a later Call B", async () => {
    // The .html source is not touched by the second compile, so its body has
    // to be recovered from its derivative — the only path that reaches a
    // non-passthrough source Luka is not currently normalizing.
    const fs = new MemFs({ "raw/paper.html": "<h1>Ranking</h1><p>UNIQUE-HTML-BODY</p>" });
    const inventory = (request: CompletionRequest): unknown =>
      request.task === "inventory"
        ? inventoryReply("About ranking.", [{ title: "Ranking", kind: "concept" }])
        : "Prose.";

    await core(fs, new StubProvider(inventory)).compile();
    expect(fs.text("raw/paper.md")).toContain("UNIQUE-HTML-BODY");

    // A new source names the same concept, so Ranking regenerates and must be
    // shown the unchanged html source's text as well as the new one's.
    await fs.write("raw/note.md", "More about ranking.\n");
    const second = new StubProvider(inventory);
    await core(fs, second).compile();

    const prompt = second.callsFor("page-generation")[0]?.user ?? "";
    // It must be the DERIVATIVE that reached the model, not the original file.
    // Both contain the same words, so only the converted *form* tells them
    // apart: §6.1 promises extraction only ever receives markdown.
    expect(prompt).toContain("# Ranking");
    expect(prompt).toContain("UNIQUE-HTML-BODY");
    expect(prompt).not.toContain("<h1>");
    expect(prompt).toContain("More about ranking.");
  });
});

describe("compile concurrency (§11, §17: 2)", () => {
  it("keeps more than one model call in flight, and never more than the setting", async () => {
    const fs = new MemFs(
      Object.fromEntries(
        [...Array(6).keys()].map((n) => [`raw/s${n}.md`, `Source number ${n}.\n`]),
      ),
    );

    let inFlight = 0;
    let peak = 0;
    const provider = new StubProvider(async (request) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return request.task === "inventory" ? inventoryReply("A source.") : "Prose.";
    });

    await core(fs, provider).compile();

    expect(peak).toBe(DEFAULT_SETTINGS.compileConcurrency);
    expect(peak).toBeGreaterThan(1);
  });

  it("honors a concurrency setting of 1", async () => {
    const fs = new MemFs(
      Object.fromEntries(
        [...Array(4).keys()].map((n) => [`raw/s${n}.md`, `Source number ${n}.\n`]),
      ),
    );

    let inFlight = 0;
    let peak = 0;
    const provider = new StubProvider(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return inventoryReply("A source.");
    });

    await core(fs, provider, {
      settings: { ...DEFAULT_SETTINGS, apiKey: "test-key", compileConcurrency: 1 },
    }).compile();

    expect(peak).toBe(1);
  });
});

describe("recompile (§15: zero model calls on an unchanged vault)", () => {
  it("makes no model calls and writes nothing", async () => {
    const fs = vault();
    await core(fs, new StubProvider(replyFor)).compile();

    fs.resetCounters();
    const second = new StubProvider(replyFor);
    const result = await core(fs, second).compile();

    expect(second.stats().requests).toBe(0);
    expect(result.modelCalls).toBe(0);
    expect(result.noop).toBe(true);
    expect(result.pagesWritten).toBe(0);
    expect(fs.writes).toBe(0);
  });

  it("reprocesses only the modified source, and the pages citing it", async () => {
    const fs = vault();
    await core(fs, new StubProvider(replyFor)).compile();

    await fs.write("raw/note.md", "# Ranking\n\nPageRank still ranks. Obsidian still renders.\n");
    const second = new StubProvider(replyFor);
    const result = await core(fs, second).compile();

    expect(result.modified).toBe(1);
    expect(second.stats().byTask.inventory).toBe(1);
    expect(second.stats().byTask.vision).toBe(0);
    // The two pages note.md cites regenerate; Graph Retrieval does not.
    expect(second.callsFor("page-generation").map((c) => /Title: (.+)/.exec(c.user)?.[1]).sort()).toEqual(
      ["Obsidian", "Personalized PageRank"],
    );
  });
});

describe("the citer record survives awkward paths (§6.5)", () => {
  it("keeps a source whose path contains a pipe across a second compile", async () => {
    // `|` is legal in a filename on macOS and Linux, and the citation block is
    // the ONLY record of a page's citers. Losing it here would drop the source
    // from the Call B prompt and, once the cascade lands, delete the page.
    const fs = new MemFs({
      "raw/a|b.md": "PageRank ranks pages. Obsidian renders them.\n",
      "raw/other.md": "PageRank ranks pages too.\n",
    });
    const reply = (request: CompletionRequest): unknown =>
      request.task === "inventory"
        ? inventoryReply("A note.", [{ title: "Personalized PageRank", kind: "concept" }])
        : "Prose.";

    await core(fs, new StubProvider(reply)).compile();
    const page = "wiki/concepts/Personalized PageRank.md";
    expect(parseCitationBlock(fs.text(page)).entries.sort()).toEqual([
      "raw/a|b.md",
      "raw/other.md",
    ]);

    // Edit one source; the other must survive the citer union unchanged.
    await fs.write("raw/other.md", "PageRank still ranks pages.\n");
    await core(fs, new StubProvider(reply)).compile();

    expect(parseCitationBlock(fs.text(page)).entries.sort()).toEqual([
      "raw/a|b.md",
      "raw/other.md",
    ]);
  });

  it("keeps a source page pointed at a path containing a pipe", async () => {
    const fs = new MemFs({ "raw/a|b.md": "Content.\n" });
    const provider = new StubProvider((request) =>
      request.task === "inventory" ? inventoryReply("A note.") : "Prose.",
    );

    await core(fs, provider).compile();
    const sourcePage = (await loadPageTable(fs)).find((page) => page.kind === "source");
    expect(sourcePage?.source).toBe("raw/a|b.md");
  });
});

describe("the index is regenerated every compile (§6.5)", () => {
  it("rewrites a hand-edited index even when no page was written", async () => {
    const fs = vault();
    await core(fs, new StubProvider(replyFor)).compile();
    const correct = fs.text("wiki/_index.md");

    // A user (or a half-finished run) leaves the index wrong. Nothing changed
    // in raw/, so no page is written — the index must still be re-derived.
    await fs.write("wiki/_index.md", "# Index\n## Sources\n## Entities\n## Concepts\n");
    const result = await core(fs, new StubProvider(replyFor)).compile();

    expect(fs.text("wiki/_index.md")).toBe(correct);
    expect(result.modelCalls).toBe(0);
  });

  it("still writes nothing at all when the index is already correct", async () => {
    const fs = vault();
    await core(fs, new StubProvider(replyFor)).compile();

    fs.resetCounters();
    const result = await core(fs, new StubProvider(replyFor)).compile();

    expect(fs.writes).toBe(0);
    expect(result.noop).toBe(true);
  });

  it("creates no wiki folder for a vault with nothing in it", async () => {
    const fs = new MemFs();
    const result = await core(fs, new StubProvider(replyFor)).compile();

    expect(result.noop).toBe(true);
    expect(fs.writes).toBe(0);
    expect(await fs.exists("wiki/_index.md")).toBe(false);
  });
});

describe("the call counter counts what the provider really does (§11, invariant 12)", () => {
  it("counts the JSON repair retry as a model call", async () => {
    // §11's repair retry is a real request. If the counter only saw logical
    // calls, invariant 12's budget would understate what the vault was billed.
    const fs = new MemFs({ "raw/note.md": "PageRank ranks pages.\n" });
    let firstInventory = true;
    const provider = new StubProvider((request) => {
      if (request.task === "inventory" && firstInventory) {
        firstInventory = false;
        return "here is your json: {oops";
      }
      return replyFor(request);
    });

    const result = await core(fs, provider).compile();

    expect(result.failed).toEqual([]);
    // One source, but two inventory requests: the original and the repair.
    expect(provider.stats().byTask.inventory).toBe(2);
    expect(result.modelCalls).toBe(provider.stats().requests);
  });

  it("counts each retry of a retryable transport failure", async () => {
    const fs = new MemFs({ "raw/note.md": "PageRank ranks pages.\n" });
    const provider = new StubProvider(
      (request) =>
        request.task === "inventory" ? retryableError("503 upstream") : replyFor(request),
      { maxRetries: 2 },
    );

    const result = await core(fs, provider).compile();

    // Three attempts for the one source, then the source is skipped (§11).
    expect(provider.stats().byTask.inventory).toBe(3);
    expect(result.failed.map((failure) => failure.path)).toEqual(["raw/note.md"]);
    // Nothing succeeded, so there is no manifest at all — invariant 3's
    // "a missing manifest is a first run, never an error" still holds.
    expect(await fs.exists(MANIFEST)).toBe(false);
  });

  it("does not retry a non-retryable failure", async () => {
    const fs = new MemFs({ "raw/note.md": "PageRank ranks pages.\n" });
    const provider = new StubProvider(
      (request) => (request.task === "inventory" ? fatalError("400 bad request") : replyFor(request)),
      { maxRetries: 2 },
    );

    await core(fs, provider).compile();
    expect(provider.stats().byTask.inventory).toBe(1);
  });

  it("sends every task under its §11 max_tokens cap", async () => {
    const { provider } = await compileOnce();
    for (const call of provider.calls) {
      expect(call.maxTokens, call.task).toBeLessThanOrEqual(MAX_TOKENS_BY_TASK[call.task]);
    }
    expect(provider.calls.length).toBeGreaterThan(0);
  });
});

describe("failure handling (invariant 3, §11)", () => {
  it("un-manifests a source whose inventory failed, so it retries", async () => {
    const fs = vault();
    const provider = new StubProvider((request) =>
      request.task === "inventory" && request.user.includes("PageRank")
        ? fatalError("inventory exploded")
        : replyFor(request),
    );

    const result = await core(fs, provider).compile();

    expect(result.failed.map((f) => f.path)).toEqual(["raw/note.md"]);
    const manifest = JSON.parse(fs.text(MANIFEST)) as Record<string, string>;
    expect(manifest["raw/note.md"]).toBeUndefined();
    // The sources that did succeed are manifested.
    expect(manifest["raw/plain.txt"]).toBeDefined();
  });

  it("un-manifests the sources that queued a page whose generation failed", async () => {
    const fs = vault();
    const provider = new StubProvider((request) =>
      request.task === "page-generation" && request.user.includes("Title: Personalized PageRank")
        ? fatalError("generation exploded")
        : replyFor(request),
    );

    const result = await core(fs, provider).compile();

    // note.md is the only source that named Personalized PageRank.
    expect(result.failed.map((f) => f.path)).toEqual(["raw/note.md"]);
    const manifest = JSON.parse(fs.text(MANIFEST)) as Record<string, string>;
    expect(manifest["raw/note.md"]).toBeUndefined();
    expect(manifest["raw/board.png"]).toBeDefined();
  });

  it("un-manifests EVERY source that queued a page whose generation failed", async () => {
    // Both sources named the same page. Retrying it means re-inventorying both,
    // so blocking only the first would strand the page forever: the second
    // source would read as unchanged and never queue it again.
    const fs = new MemFs({
      "raw/one.md": "PageRank ranks pages.\n",
      "raw/two.md": "PageRank ranks pages here too.\n",
    });
    const provider = new StubProvider((request) =>
      request.task === "inventory"
        ? inventoryReply("About ranking.", [{ title: "Personalized PageRank", kind: "concept" }])
        : fatalError("generation exploded"),
    );

    const result = await core(fs, provider).compile();

    expect(result.failed.map((failure) => failure.path).sort()).toEqual([
      "raw/one.md",
      "raw/two.md",
    ]);
    expect(await fs.exists(MANIFEST)).toBe(false);
  });

  it("keeps the pages that did succeed when a sibling page failed", async () => {
    // note.md names two pages; only one fails. The source is un-manifested so
    // it retries, but the page that succeeded must still be on disk — discarding
    // it would throw away work the user already paid for.
    const fs = vault();
    const provider = new StubProvider((request) =>
      request.task === "page-generation" && request.user.includes("Title: Personalized PageRank")
        ? fatalError("generation exploded")
        : replyFor(request),
    );

    await core(fs, provider).compile();

    expect(await fs.exists("wiki/entities/Obsidian.md")).toBe(true);
    expect(await fs.exists("wiki/concepts/Personalized PageRank.md")).toBe(false);
  });

  it("retries a failed source on the next compile and then succeeds", async () => {
    const fs = vault();
    let fail = true;
    const flaky = new StubProvider((request) =>
      fail && request.task === "inventory" && request.user.includes("PageRank")
        ? fatalError("transient")
        : replyFor(request),
    );
    await core(fs, flaky).compile();

    fail = false;
    const second = new StubProvider(replyFor);
    const result = await core(fs, second).compile();

    expect(result.failed).toEqual([]);
    expect(second.stats().byTask.inventory).toBe(1);
    expect(JSON.parse(fs.text(MANIFEST))["raw/note.md"]).toBeDefined();
  });

  it("fails the image source when the vision call fails, leaving the rest alone", async () => {
    const fs = vault();
    const provider = new StubProvider((request) =>
      request.task === "vision" ? fatalError("vision exploded") : replyFor(request),
    );

    const result = await core(fs, provider).compile();

    expect(result.failed.map((f) => f.path)).toEqual(["raw/board.png"]);
    expect(JSON.parse(fs.text(MANIFEST))["raw/board.png"]).toBeUndefined();
    expect(JSON.parse(fs.text(MANIFEST))["raw/note.md"]).toBeDefined();
  });
});
