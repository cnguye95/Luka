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

const ADD_NEXT = [
  "<!-- gaps:start -->",
  "## Add next",
  "- **the dates** — the wiki could not answer this",
  "",
  "```mermaid",
  "graph LR",
  '  a(["This answer"])',
  '  g0["the dates"]:::gap',
  "  a -.- g0",
  "  classDef gap stroke-dasharray:5 5,fill:none",
  "```",
  "<!-- gaps:end -->",
].join("\n");

function note(over: { kind?: string; addNext?: boolean } = {}): string {
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
    ...(over.addNext === true ? [ADD_NEXT, ""] : []),
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

  it("drops the Add next section with the trace", async () => {
    // The section names pages that do not exist. Kept, the next compile's
    // inventory would read those names as things this source asserts, and the
    // wiki would grow a page out of a recommendation to write one.
    const fs = new MemFs({ [NOTE_PATH]: note({ addNext: true }) });

    const text = fs.text(await fileBack(fs, NOTE_PATH));

    expect(text).not.toContain("## Add next");
    expect(text).not.toContain("gaps:start");
    expect(text).not.toContain("```mermaid");
    // And what filing is for still survives.
    expect(text).toContain("## Sources consulted");
    expect(text).toContain("- [[PageRank]]");
  });

  it("files a note that named gaps to the same bytes as one that did not", async () => {
    // So nothing downstream can tell the two apart, and the strip cannot leave
    // a residue that shifts as the section grows.
    const withSection = new MemFs({ [NOTE_PATH]: note({ addNext: true }) });
    const without = new MemFs({ [NOTE_PATH]: note() });

    const a = withSection.text(await fileBack(withSection, NOTE_PATH));
    const b = without.text(await fileBack(without, NOTE_PATH));

    expect(a).toBe(b);
  });

  it("keeps a missing list the answer carried", async () => {
    // Filing strips this run's working — the trace and the Add next section —
    // and nothing else, so the durable half of the gap signal survives into
    // `raw/answers/`, where a later compile ingests the note as a source.
    const fs = new MemFs({
      [NOTE_PATH]: note().replace("grounded: true\n", "grounded: true\nmissing:\n  - the dates\n"),
    });

    const text = fs.text(await fileBack(fs, NOTE_PATH));

    expect(text).toContain("missing:\n  - the dates");
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

describe("a filing that cannot finish does not leave two copies", () => {
  it("removes the copy it wrote when the original cannot be deleted", async () => {
    // Write-then-delete leaves the note in both places if the delete fails, and
    // the next compile ingests the copy regardless of what the user was told.
    // Retrying then lands at `-2`, so §8.4's collision suffix — meant to
    // separate two different answers — silently produces two identical sources,
    // each manifested, each costing an inventory and a page-generation call.
    const fs = vault();
    const guarded = Object.create(fs) as MemFs;
    guarded.delete = async (path: string) => {
      // Only the original is locked — the copy just written is removable,
      // which is the realistic shape of this failure.
      if (path === NOTE_PATH) throw new Error("EBUSY answers/");
      return MemFs.prototype.delete.call(fs, path);
    };

    await expect(fileBack(guarded, NOTE_PATH)).rejects.toThrow(/EBUSY/);

    // The original is still there — nothing was lost.
    expect(fs.files.has(NOTE_PATH)).toBe(true);
    // And no half-finished copy is left for compile to find.
    expect(fs.paths().filter((path) => path.startsWith("raw/answers/"))).toEqual([]);
  });
});

describe("an answer is filed once", () => {
  it("refuses a note that is already under raw/answers/", async () => {
    // Everything under `raw/` is a source. Filing a filed answer renames it
    // `-2`, `-2-2`, … and churns the manifest through §6.2's rename path each
    // time, for no gain.
    const fs = new MemFs({ "raw/answers/already.md": note() });

    await expect(fileBack(fs, "raw/answers/already.md")).rejects.toThrow(/already filed/);
    expect(fs.files.has("raw/answers/already.md")).toBe(true);
  });
});
