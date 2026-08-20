// M1's acceptance criterion, automated: ingesting demo/raw/ produces the right
// derivatives, frontmatter and markers, and an immediate second compile is a
// no-op that does zero work.
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCore, type CompileResult } from "../src/core/index";
import { decodeUtf8 } from "../src/core/hash";
import { DEFAULT_SETTINGS } from "../src/core/types";
import { StubHttp } from "./helpers/http";
import { NodeFs } from "./helpers/nodefs";

const DEMO = path.resolve(import.meta.dirname, "..", "demo", "raw");
const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";

const EXPECTED_SOURCES = [
  "raw/note.md",
  "raw/notes.txt",
  "raw/page.html",
  "raw/paper.pdf",
  "raw/runs.csv",
  "raw/toy-repo",
];

describe("demo corpus", () => {
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
    await rm(vault, { recursive: true, force: true });
  });

  function compile(): Promise<CompileResult> {
    return createCore({
      fs,
      http,
      manifestPath: MANIFEST,
      settings: DEFAULT_SETTINGS,
      now: () => new Date("2026-08-19T10:00:00Z"),
    }).compile();
  }

  const read = async (p: string) => decodeUtf8(await fs.read(p));

  it("ingests every supported source and skips the rest", async () => {
    const result = await compile();

    expect(result.added).toBe(EXPECTED_SOURCES.length);
    expect(result.failed).toEqual([]);
    expect(result.skipped.map((s) => s.path)).toEqual(["raw/orphan.png"]);

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
});
