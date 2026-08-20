import { describe, expect, it } from "vitest";
import { createCore } from "../src/core/index";
import { DEFAULT_SETTINGS } from "../src/core/types";
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

function manifestOf(fs: MemFs): Record<string, string> {
  return JSON.parse(fs.text(MANIFEST)) as Record<string, string>;
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
    const before = manifestOf(fs)["raw/note.md"];

    await fs.write("raw/note.md", "---\ningested: '2026-08-19'\nsource-format: md\n---\ntwo\n");
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ modified: 1, unchanged: 0 });
    // Writing the new hash back is what stops it reprocessing forever.
    expect(manifestOf(fs)["raw/note.md"]).not.toBe(before);

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
    const hash = manifestOf(fs)["raw/a.md"];

    await fs.move("raw/a.md", "raw/renamed.md");
    fs.resetCounters();
    const { instance, provider } = core(fs);
    const second = await instance.compile();

    expect(second).toMatchObject({ renamed: 1, added: 0, modified: 0, deleted: 0 });
    expect(manifestOf(fs)).toEqual({ "raw/renamed.md": hash });
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
  });

  it("keeps a repaired derivative when the rename's re-extraction is refused", async () => {
    // The destination stem is occupied by the user's own note, so the rename
    // falls back to re-extracting — and that re-extraction can never succeed.
    // Sweeping the old derivative first would destroy a §6.2 repair in
    // exchange for nothing at all.
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n", "raw/b.md": "My own note.\n" });
    await core(fs).instance.compile();
    await fs.write("raw/a.md", `${fs.text("raw/a.md")}\nHAND REPAIRED.\n`);

    await fs.move("raw/a.html", "raw/b.html");
    const second = await core(fs).instance.compile();

    expect(second.failed.map((failure) => failure.path)).toEqual(["raw/b.html"]);
    expect(fs.text("raw/a.md")).toContain("HAND REPAIRED.");
    expect(fs.text("raw/b.md")).toContain("My own note.");
    // Still reported on the next run rather than settling into a silent wrong.
    expect((await core(fs).instance.compile()).failed).toHaveLength(1);
    expect(fs.text("raw/a.md")).toContain("HAND REPAIRED.");
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

  it("retries the carry-over after a failed one instead of re-extracting over it", async () => {
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n" });
    await core(fs).instance.compile();
    await fs.write("raw/a.md", `${fs.text("raw/a.md")}\nHAND REPAIRED.\n`);

    await fs.move("raw/a.html", "raw/sub/a.html");

    // The move lands; the repoint write does not.
    const guarded = Object.create(fs) as MemFs;
    guarded.write = async (path: string, data: string | Uint8Array): Promise<void> => {
      if (path === "raw/sub/a.md") throw new Error("EACCES");
      return MemFs.prototype.write.call(fs, path, data);
    };
    const second = await core(guarded).instance.compile();
    expect(second.failed.map((failure) => failure.path)).toContain("raw/sub/a.html");

    // The next compile sees the same rename again and carries it properly,
    // rather than reading the file as new and re-extracting over the repair.
    const third = await core(fs).instance.compile();
    expect(third).toMatchObject({ renamed: 1, modelCalls: 0, failed: [] });
    expect(fs.text("raw/sub/a.md")).toContain("HAND REPAIRED.");
    expect(fs.text("raw/sub/a.md")).toContain("derived-from: raw/sub/a.html");
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

    expect(result.failed).toEqual([]);
    // The derivative describes the file that is actually there now.
    expect(fs.text("raw/data.md")).toContain("Rows: 2");
    expect(fs.text("raw/data.md")).not.toBe(stale);
  });

  it("makes only one of two renames competing for a derivative path carry over", async () => {
    // `a.csv` and `b.html` both move to the `q` stem, so both want `raw/q.md`.
    // The loser must be re-extracted, and deciding that at discovery is what
    // keeps it in the worklist instead of leaving it silently underivatived.
    const fs = new MemFs({
      "raw/a.csv": "a,b\n1,2\n",
      "raw/b.html": "<h1>Bee</h1>\n",
    });
    await core(fs).instance.compile();

    await fs.move("raw/a.csv", "raw/q.csv");
    await fs.move("raw/b.html", "raw/q.html");
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ renamed: 2, deleted: 0 });
    // One carries its derivative over; the other loses the stem and is
    // reported, which is the documented collision outcome — not silently left
    // manifested with no derivative of its own.
    expect(fs.text("raw/q.md")).toContain("derived-from: raw/q.csv");
    expect(second.failed.map((failure) => failure.path)).toEqual(["raw/q.html"]);
    expect(Object.keys(manifestOf(fs))).toEqual(["raw/q.csv"]);

    // And the loser keeps being reported rather than reading as ingested.
    const third = await core(fs).instance.compile();
    expect(third.failed.map((failure) => failure.path)).toEqual(["raw/q.html"]);
  });

  it("frees a derivative path once the source that owned it is deleted", async () => {
    // Two sources share a stem; the loser can never claim the path while the
    // winner lives. Deleting the winner must release it, not deadlock it.
    const fs = new MemFs({ "raw/data.csv": "a,b\n1,2\n", "raw/data.html": "<h1>Hi</h1>\n" });
    const first = await core(fs).instance.compile();
    expect(first.failed).toHaveLength(1);

    await fs.delete("raw/data.csv");
    const second = await core(fs).instance.compile();

    // The sweep frees the path even though a live source's stem points at it,
    // and the source that was blocked claims it in the very same run.
    expect(second.failed).toEqual([]);
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

  it("re-extracts a source whose derivative path holds a stranger's file", async () => {
    // `hasDerivative` checks ownership, not existence: an unrelated note at the
    // derivative location must not make the source read as fully ingested.
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n", "raw/b.md": "My own note.\n" });
    await core(fs).instance.compile();

    await fs.move("raw/a.html", "raw/b.html");
    const second = await core(fs).instance.compile();

    // The user's file is untouched and the source is not silently manifested
    // as ingested with no readable markdown behind it.
    expect(fs.text("raw/b.md")).toContain("My own note.");
    expect(second.failed.map((failure) => failure.path)).toEqual(["raw/b.html"]);
    expect(Object.keys(manifestOf(fs))).not.toContain("raw/b.html");
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
