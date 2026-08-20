import { describe, expect, it } from "vitest";
import {
  basename,
  dirname,
  extname,
  isInfrastructure,
  isUnder,
  joinPath,
  normalizePath,
  stem,
} from "../src/core/paths";

describe("paths", () => {
  it("normalizes separators and redundant segments", () => {
    expect(normalizePath("raw\\sub\\note.md")).toBe("raw/sub/note.md");
    expect(normalizePath("./raw//note.md")).toBe("raw/note.md");
    expect(normalizePath("/raw/note.md/")).toBe("raw/note.md");
    expect(normalizePath("raw/sub/../note.md")).toBe("raw/note.md");
  });

  it("splits names and extensions", () => {
    expect(dirname("raw/sub/note.md")).toBe("raw/sub");
    expect(dirname("note.md")).toBe("");
    expect(basename("raw/sub/note.md")).toBe("note.md");
    expect(extname("raw/PAPER.PDF")).toBe(".pdf");
    expect(extname("raw/README")).toBe("");
    expect(extname("raw/.luka-repo")).toBe("");
    expect(stem("raw/sub/note.tar.gz")).toBe("note.tar");
    expect(stem("raw/README")).toBe("README");
  });

  it("joins and tests containment", () => {
    expect(joinPath("raw", "assets", "a.png")).toBe("raw/assets/a.png");
    expect(isUnder("raw/assets/a.png", "raw/assets")).toBe(true);
    expect(isUnder("raw/assets", "raw/assets")).toBe(true);
    expect(isUnder("raw/assets-other/a.png", "raw/assets")).toBe(false);
  });

  it("recognizes the infrastructure prefix (invariant 8)", () => {
    expect(isInfrastructure("wiki/_index.md")).toBe(true);
    expect(isInfrastructure("wiki/index.md")).toBe(false);
  });
});
