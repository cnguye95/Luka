import { describe, expect, it } from "vitest";
import {
  isRepoDirectory,
  repoContentHash,
  repoToMarkdown,
  selectRepoFiles,
} from "../src/core/normalize/repo";
import { MemFs } from "./helpers/memfs";

const ROOT = "raw/toy-repo";

function repo(extra: Record<string, string> = {}) {
  return new MemFs({
    [`${ROOT}/.luka-repo`]: "",
    [`${ROOT}/README.md`]: "# Toy\n",
    [`${ROOT}/src/main.ts`]: "export const a = 1;\n",
    [`${ROOT}/docs/guide.md`]: "Guide.\n",
    ...extra,
  });
}

describe("repo detection", () => {
  it("recognizes a .luka-repo marker and a .git directory", async () => {
    await expect(isRepoDirectory(repo(), ROOT)).resolves.toBe(true);
    const gitRepo = new MemFs({ "raw/other/.git/HEAD": "ref: refs/heads/main\n" });
    await expect(isRepoDirectory(gitRepo, "raw/other")).resolves.toBe(true);
  });

  it("treats a plain directory as transparent organization", async () => {
    const plain = new MemFs({ "raw/folder/note.md": "x\n" });
    await expect(isRepoDirectory(plain, "raw/folder")).resolves.toBe(false);
  });
});

describe("repo selection", () => {
  it("orders README first, then docs/, then the rest breadth-first", async () => {
    const files = await selectRepoFiles(repo({ [`${ROOT}/setup.py`]: "print(1)\n" }), ROOT);
    expect(files.map((f) => f.relative)).toEqual([
      "README.md",
      "docs/guide.md",
      "setup.py",
      "src/main.ts",
    ]);
  });

  it("excludes build directories, lockfiles, the marker, and unlisted extensions", async () => {
    const files = await selectRepoFiles(
      repo({
        [`${ROOT}/node_modules/dep/index.js`]: "x\n",
        [`${ROOT}/dist/bundle.js`]: "x\n",
        [`${ROOT}/.git/HEAD`]: "ref\n",
        [`${ROOT}/package-lock.json`]: "{}\n",
        [`${ROOT}/logo.png`]: "binary\n",
        [`${ROOT}/notes.rtf`]: "x\n",
      }),
      ROOT,
    );
    expect(files.map((f) => f.relative)).toEqual(["README.md", "docs/guide.md", "src/main.ts"]);
  });

  it("includes an extensionless README at the repo root", async () => {
    const files = await selectRepoFiles(new MemFs({ [`${ROOT}/README`]: "hi\n" }), ROOT);
    expect(files.map((f) => f.relative)).toEqual(["README"]);
  });
});

describe("repo identity", () => {
  it("orders by code point, not by the host's locale collation", async () => {
    // localeCompare puts "a.md" before "B.md"; code-point order does not. The
    // walk order is the hash input, so it must not vary with locale or ICU build.
    const fs = new MemFs({
      [`${ROOT}/.luka-repo`]: "",
      [`${ROOT}/B.ts`]: "b\n",
      [`${ROOT}/a.ts`]: "a\n",
      [`${ROOT}/C.ts`]: "c\n",
    });
    const files = await selectRepoFiles(fs, ROOT);
    expect(files.map((f) => f.relative)).toEqual(["B.ts", "C.ts", "a.ts"]);
  });

  it("is deterministic across runs and independent of insertion order", async () => {
    const a = await repoContentHash(await selectRepoFiles(repo(), ROOT));
    const shuffled = new MemFs({
      [`${ROOT}/src/main.ts`]: "export const a = 1;\n",
      [`${ROOT}/README.md`]: "# Toy\n",
      [`${ROOT}/docs/guide.md`]: "Guide.\n",
      [`${ROOT}/.luka-repo`]: "",
    });
    expect(await repoContentHash(await selectRepoFiles(shuffled, ROOT))).toBe(a);
    expect(await repoContentHash(await selectRepoFiles(repo(), ROOT))).toBe(a);
  });

  it("changes when a file's content changes", async () => {
    const before = await repoContentHash(await selectRepoFiles(repo(), ROOT));
    const after = await repoContentHash(
      await selectRepoFiles(repo({ [`${ROOT}/src/main.ts`]: "export const a = 2;\n" }), ROOT),
    );
    expect(after).not.toBe(before);
  });

  it("changes when a file moves, because the path is hashed with the bytes", async () => {
    const before = await repoContentHash(await selectRepoFiles(repo(), ROOT));
    const moved = new MemFs({
      [`${ROOT}/.luka-repo`]: "",
      [`${ROOT}/README.md`]: "# Toy\n",
      [`${ROOT}/src/renamed.ts`]: "export const a = 1;\n",
      [`${ROOT}/docs/guide.md`]: "Guide.\n",
    });
    expect(await repoContentHash(await selectRepoFiles(moved, ROOT))).not.toBe(before);
  });

  it("still covers files the size caps will omit from the rendering", async () => {
    const big = "x".repeat(150_000);
    const withBig = await repoContentHash(
      await selectRepoFiles(repo({ [`${ROOT}/big.ts`]: big }), ROOT),
    );
    const withDifferentBig = await repoContentHash(
      await selectRepoFiles(repo({ [`${ROOT}/big.ts`]: `${big}y` }), ROOT),
    );
    expect(withDifferentBig).not.toBe(withBig);
  });
});

describe("repo rendering", () => {
  it("puts each file under a path header in a fenced block", async () => {
    const markdown = repoToMarkdown(ROOT, await selectRepoFiles(repo(), ROOT));
    expect(markdown).toContain("# toy-repo");
    expect(markdown).toContain("## README.md");
    expect(markdown).toContain("## src/main.ts");
    expect(markdown).toContain("```ts\nexport const a = 1;\n```");
    expect(markdown.indexOf("## README.md")).toBeLessThan(markdown.indexOf("## docs/guide.md"));
  });

  it("lengthens the fence so file content cannot break out of it", async () => {
    const fs = repo({ [`${ROOT}/src/fence.md`]: "```\ncode\n```\n" });
    const markdown = repoToMarkdown(ROOT, await selectRepoFiles(fs, ROOT));
    expect(markdown).toContain("````markdown\n```\ncode\n```\n````");
  });

  it("omits a file over 100KB and says so", async () => {
    const fs = repo({ [`${ROOT}/big.ts`]: "x".repeat(150_000) });
    const markdown = repoToMarkdown(ROOT, await selectRepoFiles(fs, ROOT));
    expect(markdown).toContain("<!-- repo file omitted: big.ts — file over 100KB -->");
    expect(markdown).not.toContain("x".repeat(1000));
  });

  it("stops including once the 1MB total is reached", async () => {
    const extra: Record<string, string> = {};
    for (let i = 0; i < 13; i++) extra[`${ROOT}/src/f${i}.ts`] = "y".repeat(90_000);
    const markdown = repoToMarkdown(ROOT, await selectRepoFiles(repo(extra), ROOT));
    expect(markdown).toContain("— repo total over 1MB -->");
  });
});
