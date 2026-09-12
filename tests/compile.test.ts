import { describe, expect, it } from "vitest";
import { createCore } from "../src/core/index";
import { DEFAULT_SETTINGS, type ManifestEntry } from "../src/core/types";
import { pngBytes } from "./helpers/images";
import { StubHttp, type StubRoute } from "./helpers/http";
import { MemFs } from "./helpers/memfs";
import { StubProvider, inventoryReply } from "./helpers/provider";

const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";

/**
 * This suite is about ingest mechanics — the four rules, the three sanctioned
 * in-place writes, discovery. The extraction phases are stubbed to the quietest
 * possible replies (a summary, no items) so they contribute a source page and
 * nothing else, and every assertion here stays about ingest.
 */
function core(fs: MemFs, routes: Record<string, StubRoute> = {}) {
  const http = new StubHttp(routes);
  const provider = new StubProvider((request) =>
    request.task === "inventory"
      ? inventoryReply("A source.")
      : request.task === "vision"
        ? "An image."
        : "Body.",
  );
  const instance = createCore({
    fs,
    http,
    manifestPath: MANIFEST,
    settings: { ...DEFAULT_SETTINGS, apiKey: "test-key" },
    now: () => new Date("2026-08-19T10:00:00Z"),
    provider,
  });
  return { instance, http, provider };
}

function manifestOf(fs: MemFs): Record<string, ManifestEntry> {
  return JSON.parse(fs.text(MANIFEST)) as Record<string, ManifestEntry>;
}

describe("first run", () => {
  it("annotates a markdown source in place and manifests it", async () => {
    const fs = new MemFs({ "raw/note.md": "# Note\n\nBody.\n" });
    const result = await core(fs).instance.compile();

    expect(result.added).toBe(1);
    expect(fs.text("raw/note.md")).toBe(
      "---\ningested: '2026-08-19'\nsource-format: md\n---\n# Note\n\nBody.\n",
    );
    expect(Object.keys(manifestOf(fs))).toEqual(["raw/note.md"]);
  });

  it("treats a missing manifest as a first run, not an error", async () => {
    const fs = new MemFs({ "raw/note.md": "x\n" });
    await expect(core(fs).instance.compile()).resolves.toMatchObject({ added: 1 });
  });

  it("does nothing at all on an empty vault", async () => {
    const fs = new MemFs();
    const result = await core(fs).instance.compile();
    expect(result).toMatchObject({ added: 0, noop: true });
    expect(fs.writes).toBe(0);
  });
});

describe("the four rules (§6.2)", () => {
  it("skips an unchanged source and writes nothing — no reprocess loop", async () => {
    const fs = new MemFs({ "raw/note.md": "# Note\n\nBody.\n", "raw/plain.txt": "text\n" });
    await core(fs).instance.compile();

    fs.resetCounters();
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ added: 0, modified: 0, unchanged: 2, noop: true });
    expect(fs.writes).toBe(0);
  });

  it("stays a no-op even when annotation added an image marker", async () => {
    const fs = new MemFs({ "raw/note.md": "![fig](https://ex.com/gone.png)\n" });
    const routes = { "https://ex.com/gone.png": { status: 404 } };

    await core(fs, routes).instance.compile();
    expect(fs.text("raw/note.md")).toContain("fetch failed, HTTP 404");

    fs.resetCounters();
    const { instance, http } = core(fs, routes);
    const second = await instance.compile();

    expect(second).toMatchObject({ unchanged: 1, noop: true });
    expect(fs.writes).toBe(0);
    expect(http.requests).toEqual([]);
  });

  it("reprocesses a modified source and records its new hash", async () => {
    const fs = new MemFs({ "raw/note.md": "one\n" });
    await core(fs).instance.compile();
    const before = manifestOf(fs)["raw/note.md"].hash;

    await fs.write("raw/note.md", "---\ningested: '2026-08-19'\nsource-format: md\n---\ntwo\n");
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ modified: 1, unchanged: 0 });
    // Writing the new hash back is what stops it reprocessing forever.
    expect(manifestOf(fs)["raw/note.md"].hash).not.toBe(before);

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ unchanged: 1, noop: true });
    expect(fs.writes).toBe(0);
  });

  it("drops a deleted source from the manifest", async () => {
    const fs = new MemFs({ "raw/a.md": "a\n", "raw/b.md": "b\n" });
    await core(fs).instance.compile();

    await fs.delete("raw/b.md");
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ deleted: 1, unchanged: 1 });
    expect(Object.keys(manifestOf(fs))).toEqual(["raw/a.md"]);
  });

  it("treats the same hash at a new path as a rename and skips regeneration", async () => {
    const fs = new MemFs({ "raw/a.md": "content\n" });
    const first = await core(fs).instance.compile();
    const entry = manifestOf(fs)["raw/a.md"];

    await fs.move("raw/a.md", "raw/renamed.md");
    fs.resetCounters();
    const { instance, provider } = core(fs);
    const second = await instance.compile();

    expect(second).toMatchObject({ renamed: 1, added: 0, modified: 0, deleted: 0 });
    expect(manifestOf(fs)).toEqual({ "raw/renamed.md": entry });
    // §6.2's "skip regeneration": no model call, and the source file itself is
    // untouched. Only the wiki's references to the old path are repointed.
    expect(provider.stats().requests).toBe(0);
    expect(fs.text("raw/renamed.md")).toBe(
      "---\ningested: '2026-08-19'\nsource-format: md\n---\ncontent\n",
    );
    expect(first.pagesWritten).toBe(1);
  });

  it("repoints the wiki at a renamed source rather than orphaning its page (§6.2, §4)", async () => {
    const fs = new MemFs({ "raw/a.md": "content\n" });
    await core(fs).instance.compile();
    const pagePath = "wiki/sources/a.md";
    expect(fs.text(pagePath)).toContain("source: '[[raw/a.md]]'");

    await fs.move("raw/a.md", "raw/renamed.md");
    await core(fs).instance.compile();

    // The page keeps its title — a rename is not a reason to rename a page —
    // but its source key and its citation block follow the file.
    expect(fs.text(pagePath)).toContain("source: '[[raw/renamed.md]]'");
    expect(fs.text(pagePath)).toContain("- [[raw/renamed.md]]");
    expect(fs.text(pagePath)).not.toContain("raw/a.md");
  });

  it("treats a move that also changes the content as two events, not a rename (§4)", async () => {
    // §4: "delete-then-add at a different path is two events". The hash differs,
    // so rename pairing must NOT fire — otherwise the new content would inherit
    // the old file's identity and never be re-extracted.
    const fs = new MemFs({ "raw/a.md": "one\n" });
    await core(fs).instance.compile();

    await fs.delete("raw/a.md");
    await fs.write("raw/renamed.md", "totally different\n");
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ renamed: 0, added: 1, deleted: 1 });
    expect(Object.keys(manifestOf(fs))).toEqual(["raw/renamed.md"]);

    // The page for the deleted source has no surviving citer, so §6.6's
    // cascade removes it; the new path gets its own page.
    expect(fs.paths().filter((path) => path.startsWith("wiki/sources/"))).toEqual([
      "wiki/sources/renamed.md",
    ]);
    expect(second.pagesDeleted).toBe(1);
  });

  it("does not create a second page when a renamed source is later edited", async () => {
    const fs = new MemFs({ "raw/a.md": "content\n" });
    await core(fs).instance.compile();

    await fs.move("raw/a.md", "raw/renamed.md");
    await core(fs).instance.compile();
    await fs.write("raw/renamed.md", "---\ningested: '2026-08-19'\nsource-format: md\n---\nedited\n");
    await core(fs).instance.compile();

    const sourcePages = fs.paths().filter((path) => path.startsWith("wiki/sources/"));
    expect(sourcePages).toEqual(["wiki/sources/a.md"]);
  });

  it("carries a renamed source's derivative over rather than re-extracting it", async () => {
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n" });
    const { instance, provider } = core(fs);
    await instance.compile();
    expect(await fs.exists("raw/a.md")).toBe(true);

    // §6.2: a derivative "persists until the original changes", and a rename
    // does not change the original — identical bytes are how it was detected.
    // So the file moves with its source and only its origin key is rewritten.
    await fs.write("raw/a.md", `${fs.text("raw/a.md")}\nHAND REPAIRED.\n`);
    await fs.move("raw/a.html", "raw/b.html");

    const before = provider.stats().requests;
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ renamed: 1, modified: 0, deleted: 0, modelCalls: 0 });
    expect(provider.stats().requests).toBe(before);
    expect(await fs.exists("raw/a.md")).toBe(false);
    expect(fs.text("raw/b.md")).toContain("derived-from: raw/b.html");
    // The user's repair survives the move — losing it is what re-extracting did.
    expect(fs.text("raw/b.md")).toContain("HAND REPAIRED.");

    // The page keeps its identity — moving a file is not a reason to lose it.
    expect(fs.paths().filter((path) => path.startsWith("wiki/sources/"))).toEqual([
      "wiki/sources/a.md",
    ]);
    expect(fs.text("wiki/sources/a.md")).toContain("source: '[[raw/b.html]]'");

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ unchanged: 1, noop: true });
    expect(fs.writes).toBe(0);
  });

  it("keeps the pages of a source moved into a subfolder (§6.2, §6.6)", async () => {
    // Moving a file leaves its derivative behind, so this always degrades to
    // rename + modified. Before the two rules composed, the old path was
    // reported deleted and the cascade removed every page citing it.
    const fs = new MemFs({ "raw/data.csv": "a,b\n1,2\n" });
    await core(fs).instance.compile();
    const page = "wiki/sources/data.md";
    expect(await fs.exists(page)).toBe(true);
    await fs.write("raw/data.md", `${fs.text("raw/data.md")}\nHAND REPAIRED.\n`);

    await fs.move("raw/data.csv", "raw/sub/data.csv");
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ deleted: 0, pagesDeleted: 0, modified: 0, modelCalls: 0 });
    expect(fs.paths().filter((path) => path.startsWith("wiki/sources/"))).toEqual([page]);
    expect(fs.text(page)).toContain("source: '[[raw/sub/data.csv]]'");
    expect(fs.text(page)).toContain("- [[raw/sub/data.csv]]");
    // The derivative travelled with its source, contents and all.
    expect(fs.text("raw/sub/data.md")).toContain("derived-from: raw/sub/data.csv");
    expect(fs.text("raw/sub/data.md")).toContain("HAND REPAIRED.");
    expect(await fs.exists("raw/data.md")).toBe(false);
    // And the entry names where it travelled to. A pointer left at the old
    // location would read as a missing derivative next compile and re-extract
    // over the repair — at a model call the rename exists to avoid.
    expect(manifestOf(fs)["raw/sub/data.csv"]?.derivative).toBe("raw/sub/data.md");

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ unchanged: 1, noop: true });
    expect(fs.writes).toBe(0);
  });

  it("returns a float home when its source is modified and the stem is free", async () => {
    // Floats decay. Normalization still prefers `<stem>.md`, so the next
    // re-extraction of a floated source lands canonically once the obstruction
    // clears, and the file it vacated is swept behind the ownership guard.
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n", "raw/b.md": "My own note.\n" });
    await core(fs).instance.compile();
    await fs.move("raw/a.html", "raw/b.html");
    await core(fs).instance.compile();
    expect(manifestOf(fs)["raw/b.html"]?.derivative).toBe("raw/a.md");

    // The user removes their note and edits the source.
    await fs.delete("raw/b.md");
    await fs.write("raw/b.html", "<h1>Hi again</h1>\n");
    const third = await core(fs).instance.compile();

    expect(third).toMatchObject({ modified: 1, failed: [] });
    expect(fs.text("raw/b.md")).toContain("derived-from: raw/b.html");
    expect(manifestOf(fs)["raw/b.html"]?.derivative).toBe("raw/b.md");
    expect(await fs.exists("raw/a.md")).toBe(false);
    expect(third.derivativesDeleted).toBeGreaterThan(0);

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ noop: true });
    expect(fs.writes).toBe(0);
  });

  it("rewrites its own floating file in place when the stem is still refused", async () => {
    // The obstruction has not cleared, so the canonical path is refused — and
    // the source rewrites the file its entry records rather than failing. That
    // file is its own, confirmed by the same guard; nobody else's is touched.
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n", "raw/b.md": "My own note.\n" });
    await core(fs).instance.compile();
    await fs.move("raw/a.html", "raw/b.html");
    await core(fs).instance.compile();

    await fs.write("raw/b.html", "<h1>Hi again</h1>\n");
    const third = await core(fs).instance.compile();

    expect(third).toMatchObject({ modified: 1, failed: [] });
    expect(fs.text("raw/a.md")).toContain("Hi again");
    expect(fs.text("raw/a.md")).toContain("derived-from: raw/b.html");
    expect(fs.text("raw/b.md")).toContain("My own note.");
    expect(manifestOf(fs)["raw/b.html"]?.derivative).toBe("raw/a.md");

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ noop: true });
    expect(fs.writes).toBe(0);
  });

  it("does not divert a write to its float because one read failed", async () => {
    // `chooseTarget` continues a float when the canonical path is *refused* —
    // a judgement about who owns a file. An IO failure is not that judgement,
    // and treating it as one moves the write somewhere else on a blip, with
    // nothing said. The same rule the missing-derivative test already follows.
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n", "raw/b.md": "My own note.\n" });
    await core(fs).instance.compile();
    await fs.move("raw/a.html", "raw/b.html");
    await core(fs).instance.compile();
    expect(manifestOf(fs)["raw/b.html"]?.derivative).toBe("raw/a.md");

    // The stem is free now, so a healthy run would bring the float home.
    await fs.delete("raw/b.md");
    await fs.write("raw/b.html", "<h1>Hi again</h1>\n");

    const guarded = Object.create(fs) as MemFs;
    guarded.exists = async (path: string): Promise<boolean> => {
      if (path === "raw/b.md") throw new Error("EIO");
      return MemFs.prototype.exists.call(fs, path);
    };

    const third = await core(guarded).instance.compile();

    // Whatever it does, it must not quietly keep writing to the float.
    expect(third.failed.map((failure) => failure.path)).toEqual(["raw/b.html"]);
    expect(manifestOf(fs)["raw/b.html"]?.derivative).toBe("raw/a.md");

    // And a healthy compile still brings it home.
    const fourth = await core(fs).instance.compile();
    expect(fourth).toMatchObject({ failed: [] });
    expect(manifestOf(fs)["raw/b.html"]?.derivative).toBe("raw/b.md");
  });

  it("sweeps a floating derivative when its source is deleted", async () => {
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n", "raw/b.md": "My own note.\n" });
    await core(fs).instance.compile();
    await fs.move("raw/a.html", "raw/b.html");
    await core(fs).instance.compile();
    expect(manifestOf(fs)["raw/b.html"]?.derivative).toBe("raw/a.md");

    await fs.delete("raw/b.html");
    const third = await core(fs).instance.compile();

    expect(third).toMatchObject({ deleted: 1, failed: [] });
    expect(await fs.exists("raw/a.md")).toBe(false);
    expect(fs.text("raw/b.md")).toContain("My own note.");
    expect(Object.keys(manifestOf(fs))).toEqual(["raw/b.md"]);
  });

  it("returns a float home when its source is renamed again into a free stem", async () => {
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n", "raw/b.md": "My own note.\n" });
    await core(fs).instance.compile();
    await fs.move("raw/a.html", "raw/b.html");
    await core(fs).instance.compile();
    expect(manifestOf(fs)["raw/b.html"]?.derivative).toBe("raw/a.md");

    await fs.move("raw/b.html", "raw/c.html");
    const third = await core(fs).instance.compile();

    expect(third).toMatchObject({ renamed: 1, modelCalls: 0, failed: [] });
    expect(fs.text("raw/c.md")).toContain("derived-from: raw/c.html");
    expect(manifestOf(fs)["raw/c.html"]?.derivative).toBe("raw/c.md");
    expect(await fs.exists("raw/a.md")).toBe(false);

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ noop: true });
    expect(fs.writes).toBe(0);
  });

  it("sweeps the old derivative once the re-extraction has actually landed", async () => {
    // Same shape, but the collision clears in the same run, so the replacement
    // is written — and only then is the old file an orphan.
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n", "raw/b.csv": "x,y\n1,2\n" });
    await core(fs).instance.compile();

    await fs.delete("raw/b.csv");
    await fs.move("raw/a.html", "raw/b.html");
    const second = await core(fs).instance.compile();

    expect(second.failed).toEqual([]);
    expect(fs.text("raw/b.md")).toContain("derived-from: raw/b.html");
    expect(await fs.exists("raw/a.md")).toBe(false);
    expect(second.derivativesDeleted).toBeGreaterThan(0);

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ noop: true });
  });

  it("re-extracts in the same run when the carry cannot move the file", async () => {
    // Policy B. The repoint lands, the move does not, and rather than leaving
    // state behind for a retry to pick up, the source simply re-extracts now.
    // That costs a model call and the hand repair — both reported — and it ends
    // the run with the vault in the state it would have reached anyway.
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n" });
    await core(fs).instance.compile();
    await fs.write("raw/a.md", `${fs.text("raw/a.md")}\nHAND REPAIRED.\n`);

    await fs.move("raw/a.html", "raw/sub/a.html");

    const guarded = Object.create(fs) as MemFs;
    guarded.move = async (from: string, to: string): Promise<void> => {
      if (from === "raw/a.md") throw new Error("EXDEV");
      return MemFs.prototype.move.call(fs, from, to);
    };
    const second = await core(guarded).instance.compile();

    // Nothing is owed afterwards, so nothing is `failed` — the source is fully
    // ingested. What it cost is reported.
    expect(second).toMatchObject({ renamed: 1, failed: [] });
    expect(second.reported.map((entry) => entry.path)).toEqual(["raw/sub/a.html"]);
    expect(second.reported[0]?.reason).toContain("re-extracted");

    // Freshly extracted, so the repair is gone — the honest outcome of a carry
    // that could not happen, rather than a half-carried file left somewhere.
    expect(fs.text("raw/sub/a.md")).toContain("derived-from: raw/sub/a.html");
    expect(fs.text("raw/sub/a.md")).not.toContain("HAND REPAIRED.");
    // And the file the carry could not move is cleaned up behind it.
    expect(await fs.exists("raw/a.md")).toBe(false);
    expect(manifestOf(fs)["raw/sub/a.html"]?.derivative).toBe("raw/sub/a.md");

    // It is finished: the next compile has nothing left to do.
    fs.resetCounters();
    const third = await core(fs).instance.compile();
    expect(third).toMatchObject({ unchanged: 1, noop: true, reported: [], failed: [] });
    expect(fs.writes).toBe(0);
  });

  it("re-extracts over its own old derivative when an extension-only carry fails", async () => {
    // `data.csv` and `data.tsv` share one derivative location, so the fallback
    // has to write over the very file it failed to repoint. That file names the
    // source's *old* path, which the invariant-7 guard refuses by default —
    // naming the old path on the accept list is what distinguishes "this
    // source's own previous markdown" from "somebody else's file".
    const fs = new MemFs({ "raw/data.csv": "a,b\n1,2\n" });
    await core(fs).instance.compile();
    await fs.write("raw/data.md", `${fs.text("raw/data.md")}\nHAND REPAIRED.\n`);
    expect(fs.text("raw/data.md")).toContain("derived-from: raw/data.csv");

    await fs.move("raw/data.csv", "raw/data.tsv");

    // The repoint keeps the body and fails; the re-extraction writes fresh
    // bytes and is allowed through.
    const guarded = Object.create(fs) as MemFs;
    guarded.write = async (path: string, data: string | Uint8Array): Promise<void> => {
      if (path === "raw/data.md" && typeof data === "string" && data.includes("HAND REPAIRED")) {
        throw new Error("EACCES");
      }
      return MemFs.prototype.write.call(fs, path, data);
    };

    const second = await core(guarded).instance.compile();

    expect(second).toMatchObject({ renamed: 1, failed: [] });
    expect(second.reported.map((entry) => entry.path)).toEqual(["raw/data.tsv"]);
    // Rebuilt in place, naming the new path, with the repair gone — the honest
    // cost of a carry that could not happen.
    expect(fs.text("raw/data.md")).toContain("derived-from: raw/data.tsv");
    expect(fs.text("raw/data.md")).not.toContain("HAND REPAIRED.");
    expect(manifestOf(fs)["raw/data.tsv"]?.derivative).toBe("raw/data.md");

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ unchanged: 1, noop: true });
    expect(fs.writes).toBe(0);
  });

  it("carries the derivative of a rename that also changes format", async () => {
    // Same bytes at a new path with a different extension: one source, and
    // §6.2's shortcut still applies. The derivative moves and is repointed; it
    // is not rebuilt just because the new extension would extract differently.
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n" });
    await core(fs).instance.compile();
    expect(fs.text("raw/a.md")).toContain("derived-from: raw/a.html");

    await fs.move("raw/a.html", "raw/sub/a.csv");
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({
      renamed: 1,
      modified: 0,
      modelCalls: 0,
      failed: [],
      reported: [],
    });
    expect(fs.text("raw/sub/a.md")).toContain("derived-from: raw/sub/a.csv");
    // Extracted as HTML, and it still says so. A rename does not re-extract, so
    // what the markdown records about its own extraction remains true of it.
    expect(fs.text("raw/sub/a.md")).toContain("source-format: html");
    expect(await fs.exists("raw/a.md")).toBe(false);
    expect(manifestOf(fs)["raw/sub/a.csv"]?.derivative).toBe("raw/sub/a.md");

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ unchanged: 1, noop: true });
    expect(fs.writes).toBe(0);
  });

  it("converges when the source is edited between a failed carry and the retry", async () => {
    // The rename can only be presented again while the source's bytes are
    // unchanged. An edit in between turns it into a delete plus an add, and the
    // vault must still settle rather than stranding markdown nothing can reach.
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n" });
    await core(fs).instance.compile();

    await fs.move("raw/a.html", "raw/sub/a.html");
    // Neither end can be written, so the carry and its fallback both fail.
    const guarded = Object.create(fs) as MemFs;
    guarded.write = async (path: string, data: string | Uint8Array): Promise<void> => {
      if (path === "raw/a.md" || path === "raw/sub/a.md") throw new Error("EACCES");
      return MemFs.prototype.write.call(fs, path, data);
    };
    await core(guarded).instance.compile();

    // The user edits the source before the retry, so the rename cannot pair.
    await fs.write("raw/sub/a.html", "<h1>Hi</h1>\n<p>More.</p>\n");
    const third = await core(fs).instance.compile();

    expect(third.failed).toEqual([]);
    expect(fs.text("raw/sub/a.md")).toContain("derived-from: raw/sub/a.html");
    expect(await fs.exists("raw/a.md")).toBe(false);

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ noop: true });
  });

  it("does not cross-pair two siblings that swapped names in their own folders", async () => {
    // Both files are byte-identical, so only position can tell them apart.
    // Preferring the basename outright hands each rename the other's history.
    const fs = new MemFs({
      "raw/a/x.html": "<h1>Same</h1>\n",
      "raw/b/y.html": "<h1>Same</h1>\n",
    });
    await core(fs).instance.compile();
    await fs.write("raw/a/x.md", `${fs.text("raw/a/x.md")}\nMARK-X.\n`);
    await fs.write("raw/b/y.md", `${fs.text("raw/b/y.md")}\nMARK-Y.\n`);

    await fs.move("raw/a/x.html", "raw/a/y.html");
    await fs.move("raw/b/y.html", "raw/b/z.html");
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ renamed: 2, deleted: 0 });
    // Each folder keeps its own file's history.
    expect(fs.text("raw/a/y.md")).toContain("MARK-X.");
    expect(fs.text("raw/b/z.md")).toContain("MARK-Y.");
  });

  it("pairs a rename with the copy it actually came from (§4)", async () => {
    // Two byte-identical sources. The user deletes one and moves the other;
    // hash alone cannot tell them apart, but the basename can.
    const fs = new MemFs({
      "raw/p.html": "<h1>Same</h1>\n",
      "raw/q.html": "<h1>Same</h1>\n",
    });
    await core(fs).instance.compile();
    await fs.write("raw/q.md", `${fs.text("raw/q.md")}\nMARK-Q.\n`);

    await fs.delete("raw/p.html");
    await fs.move("raw/q.html", "raw/sub/q.html");
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ renamed: 1, deleted: 1 });
    // q's history followed q, not p's.
    expect(fs.text("raw/sub/q.md")).toContain("MARK-Q.");
    expect(fs.paths().filter((path) => path.startsWith("wiki/sources/"))).toEqual([
      "wiki/sources/q.md",
    ]);
  });

  it("does not adopt a stale derivative left at the path a rename moves into", async () => {
    // `raw/data.md` is left over from a long-dead `raw/data.csv`. When a new
    // file is later moved to that same path, its name matches — but the file
    // describes a different document entirely, and nothing would ever notice.
    const fs = new MemFs({ "raw/data.csv": "a,b\n1,2\n" });
    await core(fs).instance.compile();
    expect(fs.text("raw/data.md")).toContain("derived-from: raw/data.csv");
    const stale = fs.text("raw/data.md");

    await fs.delete("raw/data.csv");
    await fs.write(MANIFEST, JSON.stringify({}));
    await fs.write("raw/data.md", stale); // survives as a leftover

    await fs.write("raw/notes/report.csv", "x,y,z\n9,8,7\n10,11,12\n");
    await core(fs).instance.compile();
    await fs.move("raw/notes/report.csv", "raw/data.csv");
    const result = await core(fs).instance.compile();

    expect(result).toMatchObject({ failed: [], modelCalls: 0 });
    // The rename keeps its own markdown, which describes the file that really
    // moved — and the stale leftover is never read, so it cannot be mistaken
    // for it. It is left exactly as it was found.
    expect(fs.text("raw/notes/report.md")).toContain("Rows: 2");
    expect(manifestOf(fs)["raw/data.csv"]?.derivative).toBe("raw/notes/report.md");
    expect(fs.text("raw/data.md")).toBe(stale);

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ noop: true });
    expect(fs.writes).toBe(0);
  });

  it("lands one of two renames competing for a stem and floats the other", async () => {
    // `a.csv` and `b.html` both move to the `q` stem, so both would like
    // `raw/q.md`. Only one file can be there — but the other does not need to
    // be re-extracted for that: it keeps its markdown where the entry records
    // it. Two carries, no model calls, nothing lost.
    const fs = new MemFs({
      "raw/a.csv": "a,b\n1,2\n",
      "raw/b.html": "<h1>Bee</h1>\n",
    });
    await core(fs).instance.compile();

    await fs.move("raw/a.csv", "raw/q.csv");
    await fs.move("raw/b.html", "raw/q.html");
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ renamed: 2, deleted: 0, modelCalls: 0, failed: [] });
    // The pass runs in new-path order, so `raw/q.csv` reaches the stem first
    // and `raw/q.html` keeps its own file where it lies.
    expect(fs.text("raw/q.md")).toContain("derived-from: raw/q.csv");
    expect(fs.text("raw/b.md")).toContain("derived-from: raw/q.html");
    expect(manifestOf(fs)["raw/q.csv"]?.derivative).toBe("raw/q.md");
    expect(manifestOf(fs)["raw/q.html"]?.derivative).toBe("raw/b.md");

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ unchanged: 2, noop: true });
    expect(fs.writes).toBe(0);
  });

  it("sweeps before it extracts, so a freed derivative path is claimable at once", async () => {
    // Two sources share a stem; the loser can never claim the path while the
    // winner lives. Deleting the winner must release it, not deadlock it — and
    // the sweep runs before the carry and before normalization precisely so the
    // release lands in the same run, not the next one.
    const fs = new MemFs({ "raw/data.csv": "a,b\n1,2\n", "raw/data.html": "<h1>Hi</h1>\n" });
    const first = await core(fs).instance.compile();
    expect(first.failed).toHaveLength(1);

    await fs.delete("raw/data.csv");
    const second = await core(fs).instance.compile();

    // The entry named the file, so the sweep removed exactly it — even though a
    // live source's stem points at the same path — and the source that was
    // blocked claims it in the very same run.
    expect(second.failed).toEqual([]);
    expect(second.derivativesDeleted).toBe(1);
    expect(fs.text("raw/data.md")).toContain("derived-from: raw/data.html");
    expect(Object.keys(manifestOf(fs))).toEqual(["raw/data.html"]);

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ noop: true });
    expect(fs.writes).toBe(0);
  });

  it("does not cascade on sources beneath a folder the skip rules now reject", async () => {
    // A skipped folder is never descended into, so every source under it drops
    // out of the scan — while sitting untouched in the vault. This is what a
    // change to the skip rules looks like from an already-compiled vault, and
    // it must not read as a deletion.
    const fs = new MemFs({ "raw/notes /a.html": "<h1>Hi</h1>\n" });
    await fs.write(
      MANIFEST,
      JSON.stringify({ "raw/notes /a.html": "0".repeat(64) }),
    );
    await fs.write(
      "wiki/sources/a.md",
      "---\nkind: source\nsource: '[[raw/notes /a.html]]'\n---\nBody.\n" +
        "<!-- citations:start -->\n## Sources\n- [[raw/notes /a.html]]\n<!-- citations:end -->\n",
    );

    const result = await core(fs).instance.compile();

    expect(result.skipped.map((entry) => entry.path)).toEqual(["raw/notes "]);
    expect(result).toMatchObject({ deleted: 0, pagesDeleted: 0 });
    expect(await fs.exists("wiki/sources/a.md")).toBe(true);
  });

  it("does not cascade on a source that discovery skipped (§6.1)", async () => {
    // A skipped path is still sitting in the vault — §6.1 has it "surface again
    // each compile". Treating it as vanished would delete the pages of a source
    // that never went away, which is what happens when the skip rules change
    // under a vault that already compiled.
    const fs = new MemFs({ "raw/note.md": "content\n" });
    await core(fs).instance.compile();
    expect(await fs.exists("wiki/sources/note.md")).toBe(true);

    // The path becomes unrecordable without the file moving.
    const bytes = fs.files.get("raw/note.md") as Uint8Array;
    fs.files.delete("raw/note.md");
    fs.files.set("raw/note.md odd", bytes);
    await fs.write(
      MANIFEST,
      JSON.stringify({ "raw/note.md odd": "0".repeat(64) }),
    );

    const second = await core(fs).instance.compile();

    expect(second.skipped.map((entry) => entry.path)).toEqual(["raw/note.md odd"]);
    expect(second).toMatchObject({ deleted: 0, pagesDeleted: 0 });
    expect(await fs.exists("wiki/sources/note.md")).toBe(true);
  });

  it("accepts a path whose inner segments contain spaces", async () => {
    // Only padding at the very ends of the recorded value fails to round-trip;
    // an ordinary spaced folder or filename is fine.
    const fs = new MemFs({ "raw/my notes/a note.md": "content\n" });
    const result = await core(fs).instance.compile();

    expect(result).toMatchObject({ added: 1, skipped: [] });
    expect(fs.text("wiki/sources/a note.md")).toContain("- [[raw/my notes/a note.md]]");
  });

  it("sweeps an orphan whose stem a passthrough source now occupies", async () => {
    // `.txt` writes no derivative, so it never claims `data.md`. Shielding that
    // location because a stem matches would strand the orphan permanently — and
    // block any later source that really does want to write there.
    const fs = new MemFs({ "raw/data.csv": "a,b\n1,2\n" });
    await core(fs).instance.compile();
    expect(await fs.exists("raw/data.md")).toBe(true);

    await fs.delete("raw/data.csv");
    await fs.write("raw/data.txt", "just a note\n");
    await core(fs).instance.compile();

    expect(await fs.exists("raw/data.md")).toBe(false);

    // And the freed location is claimable again.
    await fs.write("raw/data.html", "<h1>Hi</h1>\n");
    const third = await core(fs).instance.compile();
    expect(third.failed).toEqual([]);
    expect(fs.text("raw/data.md")).toContain("derived-from: raw/data.html");
  });

  it("leaves the rest of a repaired derivative's frontmatter byte-for-byte", async () => {
    // §6.2 invites the user to edit a derivative, so repointing one key must
    // not restyle their YAML: a load/dump round trip drops comments, reorders
    // keys and retypes scalars (`010` becomes `10`).
    const fs = new MemFs({ "raw/data.csv": "a,b\n1,2\n" });
    await core(fs).instance.compile();

    const original = fs.text("raw/data.md");
    await fs.write(
      "raw/data.md",
      original.replace("---\n", "---\n# my note\nmykey: 010\nflow: [a, b]\n"),
    );

    await fs.move("raw/data.csv", "raw/data.tsv");
    await core(fs).instance.compile();

    const after = fs.text("raw/data.md");
    expect(after).toContain("# my note");
    expect(after).toContain("mykey: 010");
    expect(after).toContain("flow: [a, b]");
    expect(after).toContain("derived-from: raw/data.tsv");
    expect(after).not.toContain("derived-from: raw/data.csv");
  });

  it("repoints, rather than sweeping, the derivative of an extension-only rename", async () => {
    // `data.csv` and `data.tsv` share one derivative location, so the file does
    // not move — only its origin key goes stale. Deleting it as an orphan would
    // strand the live source with no readable markdown.
    const fs = new MemFs({ "raw/data.csv": "a,b\n1,2\n" });
    await core(fs).instance.compile();
    expect(fs.text("raw/data.md")).toContain("derived-from: raw/data.csv");

    await fs.move("raw/data.csv", "raw/data.tsv");
    const second = await core(fs).instance.compile();

    // A rename, and no regeneration: §6.2's shortcut still applies.
    expect(second).toMatchObject({ renamed: 1, modified: 0, deleted: 0, failed: [] });
    expect(fs.text("raw/data.md")).toContain("derived-from: raw/data.tsv");
    expect(Object.keys(manifestOf(fs))).toEqual(["raw/data.tsv"]);

    // And it settles — the repointed key is what makes the next run a no-op.
    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ unchanged: 1, noop: true });
    expect(fs.writes).toBe(0);
  });

  it("floats past a derivative path a stranger's file holds", async () => {
    // An unrelated note sits where the new path would like its markdown. The
    // note is never read and never touched — and the source does not have to
    // be re-extracted for that, because its own markdown is intact where the
    // entry records it. It stays there, repointed.
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n", "raw/b.md": "My own note.\n" });
    await core(fs).instance.compile();
    await fs.write("raw/a.md", `${fs.text("raw/a.md")}\nHAND REPAIRED.\n`);

    await fs.move("raw/a.html", "raw/b.html");
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ renamed: 1, failed: [], modelCalls: 0 });
    expect(fs.text("raw/b.md")).toContain("My own note.");
    expect(fs.text("raw/a.md")).toContain("HAND REPAIRED.");
    expect(fs.text("raw/a.md")).toContain("derived-from: raw/b.html");
    expect(manifestOf(fs)["raw/b.html"]?.derivative).toBe("raw/a.md");

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ noop: true });
    expect(fs.writes).toBe(0);
  });
});

describe("in-place annotation stays within the three sanctioned writes (invariant 7)", () => {
  it("adds Luka's keys to a source that already has its own frontmatter", async () => {
    const fs = new MemFs({ "raw/note.md": "---\ntitle: Mine\ntags: [a, b]\n---\nBody.\n" });
    await core(fs).instance.compile();

    const text = fs.text("raw/note.md");
    expect(text).toContain("ingested: '2026-08-19'");
    expect(text).toContain("source-format: md");
    expect(text).toContain("title: Mine");
    expect(text).toContain("tags: [a, b]");

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ unchanged: 1, noop: true });
    expect(fs.writes).toBe(0);
  });

  it("ingests a file whose bytes are not valid UTF-8 without rewriting them", async () => {
    // "café\n" as Windows-1252: 0xE9 is not a valid UTF-8 sequence, and a
    // non-fatal decode would replace it with U+FFFD.
    const legacy = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    const fs = new MemFs({ "raw/legacy.txt": legacy });

    const result = await core(fs).instance.compile();

    expect(result.added).toBe(1);
    // The point of the test: the user's bytes are returned exactly as placed.
    expect(fs.files.get("raw/legacy.txt")).toEqual(legacy);

    // And the source is genuinely unchanged on the next run, not re-annotated.
    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ unchanged: 1, noop: true });
    expect(fs.writes).toBe(0);
  });

  it("keeps a byte order mark when it annotates", async () => {
    const bom = [0xef, 0xbb, 0xbf];
    const fs = new MemFs({
      "raw/bom.md": new Uint8Array([...bom, ...new TextEncoder().encode("# Hi\n")]),
    });
    await core(fs).instance.compile();

    const bytes = fs.files.get("raw/bom.md") as Uint8Array;
    expect([...bytes.subarray(0, 3)]).toEqual(bom);
    expect(fs.text("raw/bom.md")).toContain("source-format: md");

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ unchanged: 1, noop: true });
    expect(fs.writes).toBe(0);
  });
});

describe("source discovery", () => {
  it("ignores derivatives, so a derived file is never a source", async () => {
    const fs = new MemFs({ "raw/page.html": "<h1>Hi</h1>\n" });
    await core(fs).instance.compile();

    expect(fs.text("raw/page.md")).toContain("derived-from: raw/page.html");
    const second = await core(fs).instance.compile();
    expect(second).toMatchObject({ unchanged: 1, added: 0 });
    expect(Object.keys(manifestOf(fs))).toEqual(["raw/page.html"]);
  });

  it("never walks raw/assets", async () => {
    const fs = new MemFs({
      "raw/note.md": "n\n",
      "raw/assets/deadbeef.png": pngBytes(600, 400),
      "raw/assets/notes.md": "should not be a source\n",
    });
    const result = await core(fs).instance.compile();
    expect(Object.keys(manifestOf(fs))).toEqual(["raw/note.md"]);
    expect(result.skipped).toEqual([]);
  });

  it("never walks the vault's own .trash, so a deleted file cannot resurface", async () => {
    // Obsidian's local-trash setting moves a deleted file to `<vault>/.trash/`.
    // Discovery is rooted at `raw/` and only descends, so nothing at the vault
    // root is reachable — which is what stops a file the user deleted from
    // being re-ingested as a brand-new source on the next compile. README
    // §13.6 checks the same property by hand, against the real adapter.
    const fs = new MemFs({
      "raw/note.md": "n\n",
      ".trash/note.md": "the deleted copy\n",
      ".trash/other.md": "another deleted file\n",
    });

    const result = await core(fs).instance.compile();

    expect(Object.keys(manifestOf(fs))).toEqual(["raw/note.md"]);
    expect(result.skipped).toEqual([]);
  });

  it("skips unsupported files without manifesting them, so they resurface", async () => {
    const fs = new MemFs({ "raw/archive.zip": "PK\n" });
    const first = await core(fs).instance.compile();

    expect(first.skipped.map((s) => s.path)).toEqual(["raw/archive.zip"]);
    expect(first.added).toBe(0);

    const second = await core(fs).instance.compile();
    expect(second.skipped).toHaveLength(1);
  });

  it("ingests an orphan image as a source through the vision pass (§6.1)", async () => {
    const fs = new MemFs({ "raw/photo.png": pngBytes(600, 400) });
    const { instance, provider } = core(fs);

    const result = await instance.compile();

    expect(result.skipped).toEqual([]);
    expect(result.added).toBe(1);
    expect(provider.stats().byTask.vision).toBe(1);
    expect(fs.text("raw/photo.md")).toContain("derived-from: raw/photo.png");
    expect(Object.keys(manifestOf(fs))).toEqual(["raw/photo.png"]);
  });

  it("carries both renames when one vacates the location the other wants", async () => {
    // `other.html` is moving onto the stem `hold.csv` is moving off. Whether the
    // vacating rename is considered first must not decide whether the other one
    // carries — the two are ordered by the new path, which has nothing to do
    // with the dependency between them.
    const fs = new MemFs({ "raw/hold.csv": "a,b\n1,2\n", "raw/other.html": "<h1>Hi</h1>\n" });
    await core(fs).instance.compile();
    await fs.write("raw/other.md", `${fs.text("raw/other.md")}\nHAND REPAIRED.\n`);

    // The loser sorts first by new path, so it inspects `raw/hold.md` before
    // the rename that frees it has run.
    await fs.move("raw/other.html", "raw/hold.html");
    await fs.move("raw/hold.csv", "raw/zz.csv");

    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ renamed: 2, modelCalls: 0, failed: [] });
    // §6.2's repair path survives: neither rename re-extracted.
    expect(fs.text("raw/hold.md")).toContain("HAND REPAIRED.");
    expect(fs.text("raw/hold.md")).toContain("derived-from: raw/hold.html");
    expect(fs.text("raw/zz.md")).toContain("derived-from: raw/zz.csv");

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ unchanged: 2, noop: true });
    expect(fs.writes).toBe(0);
  });

  it("does not let an unrecorded copy at the destination outrank the recorded file", async () => {
    // The entry names `raw/a.md`, which the user has repaired. A stale file
    // naming the same origin also sits at the destination stem. Adopting the
    // stale one — and deleting the repaired one — is the ownership mistake
    // recorded pointers exist to prevent. The recorded file simply stays put.
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n" });
    await core(fs).instance.compile();
    await fs.write("raw/a.md", `${fs.text("raw/a.md")}\nHAND REPAIRED.\n`);
    await fs.write("raw/b.md", "---\nderived-from: raw/a.html\n---\nSTALE COPY.\n");

    await fs.move("raw/a.html", "raw/b.html");
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ renamed: 1, failed: [], modelCalls: 0 });
    // The repair is what the source keeps, and it is what the entry names.
    expect(fs.text("raw/a.md")).toContain("HAND REPAIRED.");
    expect(manifestOf(fs)["raw/b.html"]?.derivative).toBe("raw/a.md");
    // The copy was never consulted, so it is also never rewritten. Left exactly
    // as found — litter, not damage, and the pointer outranks it for good.
    expect(fs.text("raw/b.md")).toContain("STALE COPY.");

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ unchanged: 1, noop: true });
    expect(fs.writes).toBe(0);
  });

  it("says nothing about a location another outcome legitimately re-used", async () => {
    // Two clean renames where one lands on the stem the other left. Nothing was
    // left over and nothing needs attention, so nothing should be reported.
    const fs = new MemFs({ "raw/hold.csv": "a,b\n1,2\n", "raw/other.html": "<h1>Hi</h1>\n" });
    await core(fs).instance.compile();

    await fs.move("raw/hold.csv", "raw/aa.csv");
    await fs.move("raw/other.html", "raw/hold.html");

    const second = await core(fs).instance.compile();
    expect(second).toMatchObject({ renamed: 2, failed: [], reported: [] });
  });

  it("resolves two sources that swap names by floating both derivatives", async () => {
    // Each rename's destination holds the other's markdown, so neither can be
    // placed at `<stem>.md`. Neither has to be: the entry records where the
    // markdown *is*, so both files stay exactly where they lie and are simply
    // repointed at their new source. No move, no model call, no loss.
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n", "raw/b.csv": "x,y\n1,2\n" });
    await core(fs).instance.compile();
    // A repair on one of them, to pin that floating preserves §6.2's repair
    // path exactly as an ordinary carry does.
    await fs.write("raw/a.md", `${fs.text("raw/a.md")}\nHAND REPAIRED.\n`);

    const a = fs.files.get("raw/a.html") as Uint8Array;
    const b = fs.files.get("raw/b.csv") as Uint8Array;
    fs.files.delete("raw/a.html");
    fs.files.delete("raw/b.csv");
    fs.files.set("raw/b.html", a);
    fs.files.set("raw/a.csv", b);

    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ renamed: 2, modelCalls: 0, failed: [], reported: [] });
    // Each file stayed put and was repointed at its new source; the manifest
    // says where each one is, which is the only thing that has to be true.
    expect(fs.text("raw/a.md")).toContain("derived-from: raw/b.html");
    expect(fs.text("raw/a.md")).toContain("HAND REPAIRED.");
    expect(fs.text("raw/b.md")).toContain("derived-from: raw/a.csv");
    expect(manifestOf(fs)["raw/b.html"]?.derivative).toBe("raw/a.md");
    expect(manifestOf(fs)["raw/a.csv"]?.derivative).toBe("raw/b.md");

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ unchanged: 2, noop: true });
    expect(fs.writes).toBe(0);
  });

  it("never overwrites markdown that names an origin, whoever that origin is", async () => {
    // The invariant-7 write guard admits exactly one thing: markdown naming an
    // origin this source is allowed to supersede. "Naming an origin that does
    // not resolve" is not the same claim — a renamed source's old path does not
    // resolve either, and its markdown belongs to a source that is very much
    // alive.
    const fs = new MemFs({ "raw/a.html": "<p>Ranking here.</p>\n" });
    await core(fs).instance.compile();
    await fs.write("raw/a.md", `${fs.text("raw/a.md")}\nHAND REPAIRED.\n`);

    // The source moves onto a stem whose derivative location is taken, so the
    // carry falls back and its markdown stays put, still naming the old path.
    // An unrelated new source then lands on the stem the old path just freed.
    await fs.write("raw/sub/a.md", "My own note.\n");
    await fs.move("raw/a.html", "raw/sub/a.html");
    await fs.write("raw/a.csv", "x,y\n1,2\n");

    const second = await core(fs).instance.compile();

    // raw/a.md is the markdown of raw/sub/a.html, which is in the vault.
    expect(fs.text("raw/a.md")).toContain("HAND REPAIRED.");
    expect(second.failed.map((failure) => failure.path)).toContain("raw/a.csv");
  });

  it("never overwrites a user's file that merely carries a derived-from key", async () => {
    // §2 invariant 7's first clause — "Nothing else in a user-placed file is
    // ever modified" — cannot rest on the assumption that only Luka writes that
    // key. A copied or hand-edited file carries it too, and its origin may name
    // nothing at all.
    const fs = new MemFs({
      "raw/a.md": "---\nderived-from: raw/gone.html\n---\nMY OWN NOTES.\n",
      "raw/a.csv": "x,y\n1,2\n",
    });
    const result = await core(fs).instance.compile();

    expect(fs.text("raw/a.md")).toContain("MY OWN NOTES.");
    expect(result.failed.map((failure) => failure.path)).toEqual(["raw/a.csv"]);
  });

  it("still refuses a derivative whose source is merely unreadable this run", async () => {
    // The owner is skipped, not gone — §6.1 has it "surface again each compile",
    // so its markdown is still spoken for.
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n" });
    await core(fs).instance.compile();

    await fs.write("raw/a.csv", "x,y\n1,2\n");
    const second = await core(fs).instance.compile();

    expect(second.failed.map((failure) => failure.path)).toEqual(["raw/a.csv"]);
    expect(fs.text("raw/a.md")).toContain("derived-from: raw/a.html");
  });

  it("says so when it cannot read the markdown an entry names", async () => {
    // Keeping the entry is the right call — the alternative destroys a file
    // over a blip — but a source whose markdown cannot be read is not a healthy
    // source, and reading `unchanged` about it forever with nothing said is the
    // silent shape this project keeps having to remove.
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n" });
    await core(fs).instance.compile();

    let seen = 0;
    const guarded = Object.create(fs) as MemFs;
    guarded.read = async (path: string): Promise<Uint8Array> => {
      if (path === "raw/a.md") {
        seen += 1;
        if (seen > 1) throw new Error("EIO");
      }
      return MemFs.prototype.read.call(fs, path);
    };

    const second = await core(guarded).instance.compile();

    expect(second).toMatchObject({ unchanged: 1, modified: 0, modelCalls: 0, failed: [] });
    expect(second.reported.map((entry) => entry.path)).toEqual(["raw/a.html"]);
    expect(second.reported[0]?.reason).toContain("raw/a.md");
    expect(second.reported[0]?.reason).toContain("EIO");
  });

  it("does not reclassify a source because one read of its markdown failed", async () => {
    // §6.2's missing-derivative test reads the file to ask whether it is still
    // this source's. A read that fails answers neither yes nor no — treating it
    // as "not ours" re-extracts over the file, silently, on an IO blip.
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n" });
    await core(fs).instance.compile();
    await fs.write("raw/a.md", `${fs.text("raw/a.md")}\nHAND REPAIRED.\n`);

    let seen = 0;
    const guarded = Object.create(fs) as MemFs;
    guarded.read = async (path: string): Promise<Uint8Array> => {
      if (path === "raw/a.md") {
        seen += 1;
        // The first read is discovery collecting sources; the second is the
        // missing-derivative guard, which is the one under test.
        if (seen === 2) throw new Error("EIO");
      }
      return MemFs.prototype.read.call(fs, path);
    };

    const second = await core(guarded).instance.compile();
    expect(second).toMatchObject({ unchanged: 1, modified: 0, modelCalls: 0 });
    expect(fs.text("raw/a.md")).toContain("HAND REPAIRED.");
  });

  it("reports rather than aborts when the commit-time cleanup cannot look", async () => {
    // The commit point does IO. A failure there must cost one report, not the
    // whole run — the model calls have already been spent and the pages written.
    // The destination is free, so the carry moves the file — which is what
    // gives the commit point a vacated location to tidy up.
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n" });
    await core(fs).instance.compile();
    await fs.move("raw/a.html", "raw/sub/a.html");

    const guarded = Object.create(fs) as MemFs;
    guarded.exists = async (path: string): Promise<boolean> => {
      if (path === "raw/a.md") throw new Error("EIO");
      return MemFs.prototype.exists.call(fs, path);
    };

    const second = await core(guarded).instance.compile();
    expect(second.renamed).toBe(1);
    expect(second.reported.map((entry) => entry.path)).toContain("raw/sub/a.html");
  });

  it("leaves a derivative the user has taken over, and still completes", async () => {
    // The sweep's one guard. The file at the recorded path no longer names this
    // source, so it is not Luka's to delete — and the entry goes anyway, since
    // retrying cannot change whose a file is and re-presenting the deletion
    // would only repeat the notice every compile.
    const fs = new MemFs({ "raw/data.csv": "a,b\n1,2\n" });
    await core(fs).instance.compile();
    await fs.write("raw/data.md", "---\nderived-from: raw/elsewhere.csv\n---\nMine now.\n");

    await fs.delete("raw/data.csv");
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ deleted: 1, derivativesDeleted: 0, failed: [] });
    expect(second.reported.map((entry) => entry.path)).toEqual(["raw/data.csv"]);
    expect(second.reported[0]?.reason).toContain("raw/data.md");
    expect(fs.text("raw/data.md")).toContain("Mine now.");
    expect(manifestOf(fs)).toEqual({});

    // Finished, not deferred: the notice is not repeated.
    const third = await core(fs).instance.compile();
    expect(third).toMatchObject({ deleted: 0, failed: [], reported: [] });
  });

  it("reprocesses when the user has taken the recorded derivative over", async () => {
    // The entry still names the file, and a file is still there — but it is the
    // user's now. Reading "a file stands at the recorded path" as "the markdown
    // is present" would leave the source manifested as fully ingested with
    // nothing readable behind it, quietly, for good.
    const fs = new MemFs({ "raw/page.html": "<h1>Hi</h1>\n" });
    await core(fs).instance.compile();
    expect(manifestOf(fs)["raw/page.html"]?.derivative).toBe("raw/page.md");

    await fs.write("raw/page.md", "My own note now.\n");
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ modified: 1, unchanged: 0 });
    // And it stays audible: the re-extraction is refused by the invariant-7
    // guard, every compile, rather than the problem going silent.
    expect(second.failed.map((failure) => failure.path)).toEqual(["raw/page.html"]);
    expect(fs.text("raw/page.md")).toContain("My own note now.");

    const third = await core(fs).instance.compile();
    expect(third.failed.map((failure) => failure.path)).toEqual(["raw/page.html"]);
  });

  it("reprocesses when a folder has taken the derivative's place", async () => {
    // Mere existence is not enough: a directory at the recorded path is not
    // readable markdown, and reading it as the derivative would leave the
    // source manifested with nothing behind it.
    const fs = new MemFs({ "raw/page.html": "<h1>Hi</h1>\n" });
    await core(fs).instance.compile();

    await fs.delete("raw/page.md");
    await fs.mkdir("raw/page.md");
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ modified: 1, unchanged: 0 });
    // Re-extraction cannot land on a directory either, so it is reported —
    // which is the point: the problem surfaces instead of going quiet.
    expect(second.failed.map((failure) => failure.path)).toEqual(["raw/page.html"]);

    // Invariant 3 keeps the previous entry, so the source reads as modified
    // again and keeps being reported — rather than going quiet with a
    // directory standing in for its markdown.
    expect(manifestOf(fs)["raw/page.html"]?.derivative).toBe("raw/page.md");
    const third = await core(fs).instance.compile();
    expect(third).toMatchObject({ modified: 1, unchanged: 0 });
    expect(third.failed.map((failure) => failure.path)).toEqual(["raw/page.html"]);
  });

  it("re-extracts once from a manifest written before ownership was recorded", async () => {
    // The old shape was `path -> hash`, which names no derivative — so a
    // converting source's cannot be located and §6.2's missing-derivative rule
    // fires. That costs one re-extraction, which records the pointer. A
    // passthrough source has no derivative to name and is unaffected.
    const fs = new MemFs({ "raw/page.html": "<h1>Hi</h1>\n", "raw/note.md": "Body.\n" });
    await core(fs).instance.compile();
    const recorded = manifestOf(fs);
    expect(recorded["raw/page.html"]?.derivative).toBe("raw/page.md");

    await fs.write(
      MANIFEST,
      JSON.stringify(
        Object.fromEntries(Object.entries(recorded).map(([path, entry]) => [path, entry.hash])),
      ),
    );

    const second = await core(fs).instance.compile();
    expect(second).toMatchObject({ modified: 1, unchanged: 1, added: 0, deleted: 0 });
    // The re-extraction restores exactly the entries the old file had lost.
    expect(manifestOf(fs)).toEqual(recorded);

    // One wave, not a loop: the recorded pointer is what settles the vault.
    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ unchanged: 2, noop: true });
    expect(fs.writes).toBe(0);
  });

  it("reprocesses when a derivative has gone missing", async () => {
    const fs = new MemFs({ "raw/page.html": "<h1>Hi</h1>\n" });
    await core(fs).instance.compile();

    await fs.delete("raw/page.md");
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ modified: 1, unchanged: 0 });
    expect(fs.text("raw/page.md")).toContain("derived-from: raw/page.html");
  });
});

describe("repositories", () => {
  it("ingests a marked directory as one source and not as individual files", async () => {
    const fs = new MemFs({
      "raw/toy-repo/.luka-repo": "",
      "raw/toy-repo/README.md": "# Toy\n",
      "raw/toy-repo/src/main.ts": "export const a = 1;\n",
      "raw/note.md": "n\n",
    });
    await core(fs).instance.compile();

    expect(Object.keys(manifestOf(fs)).sort()).toEqual(["raw/note.md", "raw/toy-repo"]);
    expect(fs.text("raw/toy-repo.md")).toContain("## src/main.ts");
    expect(fs.text("raw/toy-repo.md")).toContain("derived-from: raw/toy-repo");
  });

  it("sees a file change inside the repo as a modification of the repo", async () => {
    const fs = new MemFs({
      "raw/toy-repo/.luka-repo": "",
      "raw/toy-repo/README.md": "# Toy\n",
    });
    await core(fs).instance.compile();

    await fs.write("raw/toy-repo/README.md", "# Toy, revised\n");
    const second = await core(fs).instance.compile();
    expect(second).toMatchObject({ modified: 1 });
  });
});

describe("failures", () => {
  it("refuses to overwrite a user file that occupies a derivative path", async () => {
    const fs = new MemFs({
      "raw/page.html": "<h1>Hi</h1>\n",
      "raw/page.md": "My own notes.\n",
    });
    const result = await core(fs).instance.compile();

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe("raw/page.html");
    expect(fs.text("raw/page.md")).toContain("My own notes.");
  });

  it("does not manifest a failed source, so the next compile retries it", async () => {
    const fs = new MemFs({ "raw/page.html": "<h1>Hi</h1>\n", "raw/page.md": "mine\n" });
    await core(fs).instance.compile();

    expect(manifestOf(fs)["raw/page.html"]).toBeUndefined();
    const second = await core(fs).instance.compile();
    expect(second.failed).toHaveLength(1);
  });
});

describe("the operation lock (invariant 2)", () => {
  it("refuses a concurrent compile", async () => {
    const fs = new MemFs({ "raw/note.md": "n\n" });
    const { instance } = core(fs);

    const first = instance.compile();
    await expect(instance.compile()).rejects.toThrow("Luka is busy: compile");
    await first;
    expect(instance.busyWith).toBe(null);
  });
});
