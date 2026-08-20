import { describe, expect, it } from "vitest";
import { createCore } from "../src/core/index";
import { DEFAULT_SETTINGS } from "../src/core/types";
import { pngBytes } from "./helpers/images";
import { StubHttp, type StubRoute } from "./helpers/http";
import { MemFs } from "./helpers/memfs";

const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";

function core(fs: MemFs, routes: Record<string, StubRoute> = {}) {
  const http = new StubHttp(routes);
  const instance = createCore({
    fs,
    http,
    manifestPath: MANIFEST,
    settings: DEFAULT_SETTINGS,
    now: () => new Date("2026-08-19T10:00:00Z"),
  });
  return { instance, http };
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
    await core(fs).instance.compile();
    const hash = manifestOf(fs)["raw/a.md"];

    await fs.move("raw/a.md", "raw/renamed.md");
    fs.resetCounters();
    const second = await core(fs).instance.compile();

    expect(second).toMatchObject({ renamed: 1, added: 0, modified: 0, deleted: 0 });
    expect(manifestOf(fs)).toEqual({ "raw/renamed.md": hash });
    // The only write is the manifest itself; the file was not re-annotated.
    expect(fs.writes).toBe(1);
  });

  it("reprocesses a renamed source whose derivative is not at the new path", async () => {
    const fs = new MemFs({ "raw/a.html": "<h1>Hi</h1>\n" });
    await core(fs).instance.compile();
    expect(await fs.exists("raw/a.md")).toBe(true);

    await fs.move("raw/a.html", "raw/b.html");
    const second = await core(fs).instance.compile();

    // §6.2's missing-derivative rule wins over the rename shortcut, so the new
    // path gets a derivative rather than silently having none.
    expect(second).toMatchObject({ renamed: 0, modified: 1, deleted: 1 });
    expect(fs.text("raw/b.md")).toContain("derived-from: raw/b.html");
    expect(Object.keys(manifestOf(fs))).toEqual(["raw/b.html"]);

    fs.resetCounters();
    expect(await core(fs).instance.compile()).toMatchObject({ unchanged: 1, noop: true });
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
    expect(fs.files.get("raw/legacy.txt")).toEqual(legacy);
    expect(fs.writes).toBe(1); // the manifest only
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
    const fs = new MemFs({ "raw/archive.zip": "PK\n", "raw/photo.png": pngBytes(600, 400) });
    const first = await core(fs).instance.compile();

    expect(first.skipped.map((s) => s.path)).toEqual(["raw/archive.zip", "raw/photo.png"]);
    expect(first.added).toBe(0);

    const second = await core(fs).instance.compile();
    expect(second.skipped).toHaveLength(2);
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
