import { describe, expect, it } from "vitest";
import { datasetToMarkdown } from "../src/core/normalize/dataset";
import { repoContentHash, repoToMarkdown, selectRepoFiles } from "../src/core/normalize/repo";
import { MemFs } from "./helpers/memfs";

describe("a wide dataset is summarised, not tabulated", () => {
  const wide = (cols: number, rows: number) => {
    const header = Array.from({ length: cols }, (_, i) => `col${i}`).join(",");
    const body = Array.from({ length: rows }, (_, i) => `r${i}`).join("\n");
    return `${header}\n${body}\n`;
  };

  it("renders a 4000-column file without walking every column against every row", () => {
    // The cost used to be columns x rows regardless of how many cells the file
    // actually holds, so a ragged file blocked the global operation lock for
    // close to a minute. §6.1 asks for a schema, a row count and a ten-row
    // head — none of which requires a row per column.
    const started = Date.now();
    const out = datasetToMarkdown(wide(4000, 4000), "raw/wide.csv");
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2000);
    // Still tells the truth about the shape.
    expect(out).toContain("- Columns: 4000");
    expect(out).toContain("- Rows: 4000");
    // And says what it left out, per invariant 4.
    expect(out).toMatch(/<!-- .*columns.* -->/);
  });

  it("still describes a small file in full", () => {
    const out = datasetToMarkdown("a,b\n1,2\n3,4\n", "raw/small.csv");
    expect(out).toContain("| a |");
    expect(out).toContain("| b |");
    expect(out).toContain("- Rows: 2");
    expect(out).not.toMatch(/<!-- .*columns.* -->/);
  });
});

describe("repo identity frames path and content", () => {
  const repo = async (files: Record<string, string>) => {
    const seed: Record<string, string> = { "raw/r/.luka-repo": "" };
    for (const [rel, body] of Object.entries(files)) seed[`raw/r/${rel}`] = body;
    const fs = new MemFs(seed);
    return selectRepoFiles(fs, "raw/r");
  };

  it("does not confuse a file boundary with file content", async () => {
    // Concatenating every path and every file's bytes into one buffer made
    // these two repos hash identically, so a repo mutating between them read as
    // unchanged under §6.2's four rules and was never reprocessed.
    const a = await repoContentHash(await repo({ "docs/a.md": "X", "docs/b.md": "Y" }));
    const b = await repoContentHash(await repo({ "docs/a.md": "Xdocs/b.mdY" }));
    expect(a).not.toBe(b);
  });

  it("does not confuse a path with the start of its own content", async () => {
    // Hashing each file separately fixes the case above on its own, but within
    // one file `relative + bytes` is still ambiguous: "x.md" holding "y.md" and
    // "x.mdy.md" holding nothing concatenate to the same string. Only the
    // length prefixes tell them apart.
    const a = await repoContentHash(await repo({ "x.md": "y.md" }));
    const b = await repoContentHash(await repo({ "x.mdy.md": "" }));
    expect(a).not.toBe(b);
  });

  it("still changes when a file's content changes", async () => {
    const a = await repoContentHash(await repo({ "docs/a.md": "one" }));
    const b = await repoContentHash(await repo({ "docs/a.md": "two" }));
    expect(a).not.toBe(b);
  });

  it("covers content that is too big to render", async () => {
    // BUILD-NOTES is explicit that identity ignores the size caps: an over-cap
    // file's change must still register.
    const big = (fill: string) => fill.repeat(200 * 1024);
    const a = await repoContentHash(await repo({ "big.md": big("a") }));
    const b = await repoContentHash(await repo({ "big.md": big("b") }));
    expect(a).not.toBe(b);
  });

  it("does not hold the bytes of a file it cannot render", async () => {
    // Reading 200MB of over-cap files to produce a derivative containing only
    // omission markers should not keep 200MB resident.
    const files = await repo({ "big.md": "x".repeat(200 * 1024), "small.md": "hello" });
    const big = files.find((f) => f.relative === "big.md");
    const small = files.find((f) => f.relative === "small.md");

    expect(big?.bytes).toBeNull();
    expect(small?.bytes).not.toBeNull();
    // The renderer still says why.
    const rendered = repoToMarkdown("raw/r", files);
    expect(rendered).toContain("repo file omitted");
    expect(rendered).toContain("hello");
  });
});
