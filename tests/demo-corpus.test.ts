// M1's acceptance criterion, automated: ingesting demo/raw/ produces the right
// derivatives, frontmatter and markers, and an immediate second compile is a
// no-op that does zero work.
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCore,
  type CompileOptions,
  type CompileResult,
  type ScopePreview,
} from "../src/core/index";
import { decodeUtf8 } from "../src/core/hash";
import { DEFAULT_SETTINGS } from "../src/core/types";
import { StubHttp } from "./helpers/http";
import { NodeFs } from "./helpers/nodefs";
import { StubProvider, inventoryReply } from "./helpers/provider";

const DEMO = path.resolve(import.meta.dirname, "..", "demo", "raw");
const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";

const EXPECTED_SOURCES = [
  "raw/note.md",
  "raw/notes.txt",
  "raw/orphan.png",
  "raw/page.html",
  "raw/paper.pdf",
  "raw/runs.csv",
  "raw/toy-repo",
];

// This is the one suite that touches a real filesystem and runs pdf.js, so a
// compile here costs seconds rather than milliseconds. The default 5s timeout
// leaves no headroom on a loaded machine, and a timeout mid-write is also what
// produces the ENOTEMPTY cleanup failures on Windows.
const SLOW = 30_000;

describe("demo corpus", { timeout: SLOW }, () => {
  let vault: string;
  let fs: NodeFs;
  let http: StubHttp;

  beforeEach(async () => {
    vault = await mkdtemp(path.join(tmpdir(), "luka-demo-"));
    await cp(DEMO, path.join(vault, "raw"), { recursive: true });
    fs = new NodeFs(vault);
    // No routes: the demo's .invalid figure always fails, deterministically.
    http = new StubHttp({});
  });

  afterEach(async () => {
    // Windows keeps handles briefly after the last write, so a single rmdir
    // can lose a race with itself; retries make teardown reliable.
    await rm(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /**
   * This suite asserts M1's ingest criteria, so the extraction phases are
   * stubbed to their quietest replies: a one-line summary and no items, which
   * yields one source page per source and no Call B at all.
   */
  function compile(options: CompileOptions = {}): Promise<CompileResult> {
    return createCore({
      fs,
      http,
      manifestPath: MANIFEST,
      settings: { ...DEFAULT_SETTINGS, apiKey: "test-key" },
      now: () => new Date("2026-08-19T10:00:00Z"),
      provider: new StubProvider((request) =>
        request.task === "inventory"
          ? inventoryReply("A demo source.")
          : request.task === "vision"
            ? "A generated fixture image, 160 by 120 pixels."
            : "Body.",
      ),
    }).compile(options);
  }

  const read = async (p: string) => decodeUtf8(await fs.read(p));

  it("ingests every supported source and skips the rest", async () => {
    const result = await compile();

    expect(result.added).toBe(EXPECTED_SOURCES.length);
    expect(result.failed).toEqual([]);
    // Every file in the demo corpus is a supported format, the orphan image
    // included — §6.1's vision row makes it a source with its own page.
    expect(result.skipped).toEqual([]);

    const manifest = JSON.parse(await read(MANIFEST)) as Record<string, string>;
    expect(Object.keys(manifest).sort()).toEqual(EXPECTED_SOURCES);
    for (const hash of Object.values(manifest)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("annotates passthrough sources in place without converting them", async () => {
    await compile();

    const note = await read("raw/note.md");
    expect(note.startsWith("---\ningested: '2026-08-19'\nsource-format: md\n---\n")).toBe(true);
    expect(note).toContain("# Graph-Based Retrieval");
    expect(await read("raw/notes.txt")).toContain("source-format: txt");
  });

  it("marks the unreachable figure and leaves both its link and the data URI alone", async () => {
    await compile();
    const note = await read("raw/note.md");

    expect(note).toContain("![Figure 1: the compile pipeline](https://luka.invalid/fig1.png)");
    expect(note).toContain("<!-- image not fetched: fig1.png — fetch failed, network error -->");
    expect(note).not.toContain("removed");
    expect(note).toContain("![](data:image/gif;base64,");
  });

  it("writes a derivative for every converting format", async () => {
    await compile();

    for (const derivative of ["raw/page.md", "raw/paper.md", "raw/runs.md", "raw/toy-repo.md"]) {
      expect(await fs.exists(derivative)).toBe(true);
    }

    const html = await read("raw/page.md");
    expect(html).toContain("derived-from: raw/page.html");
    expect(html).toContain("# Personalized PageRank in one page");
    expect(html).not.toContain("this script is stripped");

    const pdf = await read("raw/paper.md");
    expect(pdf).toContain("source-format: pdf");
    expect(pdf).toContain("Compiling A Wiki From Source Documents");
    expect(pdf).toContain("Retrieval Without Embeddings");

    const dataset = await read("raw/runs.md");
    expect(dataset).toContain("- Rows: 15");
    expect(dataset).toContain("## First 10 rows");

    const repo = await read("raw/toy-repo.md");
    expect(repo).toContain("## README.md");
    expect(repo).toContain("## docs/design.md");
    expect(repo).toContain("## src/ppr.ts");
    expect(repo.indexOf("## README.md")).toBeLessThan(repo.indexOf("## docs/design.md"));
    expect(repo.indexOf("## docs/design.md")).toBeLessThan(repo.indexOf("## src/graph.ts"));
  });

  it("does zero work on an immediate second compile", async () => {
    await compile();
    fs.resetCounters();
    http.requests.length = 0;

    const second = await compile();

    expect(second).toMatchObject({
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
      unchanged: EXPECTED_SOURCES.length,
      noop: true,
    });
    expect(fs.writes).toBe(0);
    expect(http.requests).toEqual([]);
  });

  it("still does zero work on a third compile", async () => {
    await compile();
    await compile();
    fs.resetCounters();

    expect(await compile()).toMatchObject({ noop: true, unchanged: EXPECTED_SOURCES.length });
    expect(fs.writes).toBe(0);
  });

  // §15's M2 criterion: "deleting a demo source shows the preview then
  // regenerates/deletes correctly".
  it("shows the scope preview for a deleted source, then deletes its page", async () => {
    await compile();
    expect(await fs.exists("wiki/sources/page.md")).toBe(true);

    await fs.delete("raw/page.html");

    const seen: ScopePreview[] = [];
    const result = await compile({
      confirm: (preview) => {
        seen.push(preview);
        return true;
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ deleted: 1, added: 0, modified: 0, regenerate: [] });
    expect(seen[0]?.mayDelete).toEqual(["wiki/sources/page.md"]);

    expect(result).toMatchObject({ deleted: 1, pagesDeleted: 1, cancelled: false, failed: [] });
    expect(await fs.exists("wiki/sources/page.md")).toBe(false);
    // The derivative Luka wrote for that source goes with it.
    expect(await fs.exists("raw/page.md")).toBe(false);
    expect(await read("wiki/_index.md")).not.toContain("[[page]]");

    const manifest = JSON.parse(await read(MANIFEST)) as Record<string, string>;
    expect(Object.keys(manifest).sort()).toEqual(
      EXPECTED_SOURCES.filter((source) => source !== "raw/page.html"),
    );

    // And the vault settles: the compile after a cascade is a no-op.
    fs.resetCounters();
    expect(await compile()).toMatchObject({ noop: true, pagesDeleted: 0 });
    expect(fs.writes).toBe(0);
  });

  it("changes nothing when the scope preview is declined", async () => {
    await compile();
    await fs.delete("raw/page.html");

    fs.resetCounters();
    const result = await compile({ confirm: () => false });

    expect(result).toMatchObject({ cancelled: true, noop: true, deleted: 1 });
    expect(fs.writes).toBe(0);
    expect(await fs.exists("wiki/sources/page.md")).toBe(true);
    expect(await fs.exists("raw/page.md")).toBe(true);
  });
});
