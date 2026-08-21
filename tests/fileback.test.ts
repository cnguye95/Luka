// §8.4's filing. §14's minimum set names "fileback move + trace strip +
// collision suffix".
import { describe, expect, it } from "vitest";
import { fileBack } from "../src/core/answer/fileback";
import { MemFs } from "./helpers/memfs";

const SOURCES = [
  "<!-- sources:start -->",
  "## Sources consulted",
  "- [[PageRank]]",
  "<!-- sources:end -->",
].join("\n");

const TRACE = [
  "<!-- trace:start -->",
  "## Retrieval trace",
  "- mode: B",
  "- seeds: [[PageRank]]",
  "- round2: no",
  "- top: [[PageRank]] 0.4408",
  "<!-- trace:end -->",
].join("\n");

const NOTE_PATH = "answers/2026-08-20-1007 how-does-ranking-work.md";

function note(over: { kind?: string } = {}): string {
  return [
    "---",
    `kind: ${over.kind ?? "answer"}`,
    "question: How does ranking work?",
    "asked: '2026-08-20T10:07:00.000Z'",
    "mode: B",
    "grounded: true",
    "---",
    "Ranking uses [[PageRank]].",
    "",
    SOURCES,
    "",
    TRACE,
    "",
  ].join("\n");
}

const vault = () => new MemFs({ [NOTE_PATH]: note() });

describe("filing moves the note into raw/answers/ (§8.4)", () => {
  it("writes it under its same name and removes the original", async () => {
    const fs = vault();

    const filed = await fileBack(fs, NOTE_PATH);

    expect(filed).toBe("raw/answers/2026-08-20-1007 how-does-ranking-work.md");
    expect(fs.files.has(NOTE_PATH)).toBe(false);
    expect(fs.text(filed)).toContain("Ranking uses [[PageRank]].");
  });

  it("strips the trace block and keeps the sources block", async () => {
    // The trace is this run's working. The sources block's links become graph
    // edges (§7.1) once the note is compiled, which is how filing densifies
    // the graph rather than merely archiving prose.
    const fs = vault();

    const filed = await fileBack(fs, NOTE_PATH);
    const text = fs.text(filed);

    expect(text).not.toContain("Retrieval trace");
    expect(text).not.toContain("trace:start");
    expect(text).toContain("## Sources consulted");
    expect(text).toContain("- [[PageRank]]");
  });

  it("keeps the frontmatter, so compile can still tell what it is", async () => {
    const fs = vault();

    const text = fs.text(await fileBack(fs, NOTE_PATH));

    expect(text.startsWith("---\nkind: answer\n")).toBe(true);
    expect(text).toContain("asked: '2026-08-20T10:07:00.000Z'");
  });

  it("suffixes on collision rather than overwriting", async () => {
    const fs = new MemFs({
      [NOTE_PATH]: note(),
      "raw/answers/2026-08-20-1007 how-does-ranking-work.md": "An earlier answer.\n",
    });

    const filed = await fileBack(fs, NOTE_PATH);

    expect(filed).toBe("raw/answers/2026-08-20-1007 how-does-ranking-work-2.md");
    // The earlier answer is untouched.
    expect(fs.text("raw/answers/2026-08-20-1007 how-does-ranking-work.md")).toBe(
      "An earlier answer.\n",
    );
  });

  it("keeps counting past -2", async () => {
    const fs = new MemFs({
      [NOTE_PATH]: note(),
      "raw/answers/2026-08-20-1007 how-does-ranking-work.md": "First.\n",
      "raw/answers/2026-08-20-1007 how-does-ranking-work-2.md": "Second.\n",
    });

    expect(await fileBack(fs, NOTE_PATH)).toBe(
      "raw/answers/2026-08-20-1007 how-does-ranking-work-3.md",
    );
  });

  it("suffixes the stem, not the extension", async () => {
    const fs = new MemFs({
      [NOTE_PATH]: note(),
      "raw/answers/2026-08-20-1007 how-does-ranking-work.md": "First.\n",
    });

    expect(await fileBack(fs, NOTE_PATH)).toMatch(/-2\.md$/);
  });
});

describe("filing refuses anything that is not an answer", () => {
  it("throws rather than moving a file the user did not ask about", async () => {
    // Everything under `raw/` becomes a source on the next compile, so filing
    // an arbitrary file is a vault edit nobody requested.
    const fs = new MemFs({ "answers/notes.md": note({ kind: "concept" }) });

    await expect(fileBack(fs, "answers/notes.md")).rejects.toThrow(/not an answer note/);
    expect(fs.files.has("answers/notes.md")).toBe(true);
  });

  it("throws on a file with no frontmatter at all", async () => {
    const fs = new MemFs({ "answers/plain.md": "Just prose.\n" });

    await expect(fileBack(fs, "answers/plain.md")).rejects.toThrow(/not an answer note/);
  });
});

describe("a failure leaves the answer where the user can see it", () => {
  it("does not delete the original when the write fails", async () => {
    const fs = vault();
    const guarded = Object.create(fs) as MemFs;
    guarded.write = async () => {
      throw new Error("EACCES raw/answers");
    };

    await expect(fileBack(guarded, NOTE_PATH)).rejects.toThrow(/EACCES/);

    expect(fs.files.has(NOTE_PATH)).toBe(true);
  });
});
