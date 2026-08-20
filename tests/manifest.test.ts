import { describe, expect, it } from "vitest";
import {
  CASCADE_PENDING,
  isSameManifest,
  loadManifest,
  readablePathOf,
  saveManifest,
} from "../src/core/manifest";
import { MemFs } from "./helpers/memfs";

const PATH = ".obsidian/plugins/luka/ingest-manifest.json";

describe("ingest manifest", () => {
  it("treats a missing file as a first run, not an error (invariant 3)", async () => {
    await expect(loadManifest(new MemFs(), PATH)).resolves.toEqual({});
  });

  it("self-heals a corrupt file as a first run", async () => {
    const fs = new MemFs({ [PATH]: "{not json" });
    await expect(loadManifest(fs, PATH)).resolves.toEqual({});
  });

  it("drops values it cannot read rather than trusting them", async () => {
    const fs = new MemFs({
      [PATH]: JSON.stringify({
        "raw/a.md": { hash: "abc" },
        "raw/b.md": 7,
        "raw/c.md": { derivative: "raw/c.md" },
        "raw/d.md": { hash: 7 },
        "raw/e.md": [],
        "raw/f.md": null,
      }),
    });
    await expect(loadManifest(fs, PATH)).resolves.toEqual({ "raw/a.md": { hash: "abc" } });
  });

  it("ignores a derivative that is not a path", async () => {
    const fs = new MemFs({
      [PATH]: JSON.stringify({ "raw/a.html": { hash: "abc", derivative: 7 } }),
    });
    await expect(loadManifest(fs, PATH)).resolves.toEqual({ "raw/a.html": { hash: "abc" } });
  });

  it("reads a bare string as a hash with no recorded derivative", async () => {
    // The shape written before ownership was recorded. Such a source reads as
    // modified once (its derivative is unknown) and records a pointer then.
    const fs = new MemFs({
      [PATH]: JSON.stringify({ "raw/a.md": "hash-a", "raw/b.html": "hash-b" }),
    });
    await expect(loadManifest(fs, PATH)).resolves.toEqual({
      "raw/a.md": { hash: "hash-a" },
      "raw/b.html": { hash: "hash-b" },
    });
  });

  it("writes code-point-sorted keys so the file does not churn between runs", async () => {
    const fs = new MemFs();
    await saveManifest(fs, PATH, {
      "raw/z.md": { hash: "2" },
      "raw/a.html": { hash: "1", derivative: "raw/a.md" },
    });
    expect(fs.text(PATH)).toBe(
      '{\n  "raw/a.html": {\n    "hash": "1",\n    "derivative": "raw/a.md"\n  },\n' +
        '  "raw/z.md": {\n    "hash": "2"\n  }\n}\n',
    );
  });

  it("round-trips, derivative pointers included", async () => {
    const fs = new MemFs();
    const manifest = {
      "raw/a.md": { hash: "hash-a" },
      "raw/sub/b.pdf": { hash: "hash-b", derivative: "raw/sub/b.md" },
      "raw/gone.csv": { hash: CASCADE_PENDING, derivative: "raw/gone.md" },
    };
    await saveManifest(fs, PATH, manifest);
    await expect(loadManifest(fs, PATH)).resolves.toEqual(manifest);
  });

  it("compares structurally, not by reference", async () => {
    const a = { "raw/a.html": { hash: "h", derivative: "raw/a.md" } };
    // Fresh objects with identical contents: every run rebuilds its entries, so
    // reference equality would report every compile as a change.
    expect(isSameManifest(a, { "raw/a.html": { hash: "h", derivative: "raw/a.md" } })).toBe(true);
    expect(isSameManifest(a, { "raw/a.html": { hash: "h" } })).toBe(false);
    expect(isSameManifest(a, { "raw/a.html": { hash: "other", derivative: "raw/a.md" } })).toBe(
      false,
    );
    expect(isSameManifest(a, {})).toBe(false);
    expect(isSameManifest(a, { "raw/b.html": { hash: "h", derivative: "raw/a.md" } })).toBe(false);
  });
});

describe("readablePathOf (§7.1)", () => {
  it("is the source itself when no derivative was recorded", () => {
    expect(readablePathOf("raw/note.md", { hash: "h" })).toBe("raw/note.md");
  });

  it("is the derivative when one was recorded", () => {
    expect(readablePathOf("raw/paper.pdf", { hash: "h", derivative: "raw/paper.md" })).toBe(
      "raw/paper.md",
    );
  });

  it("is nothing for a source whose cascade is still pending", () => {
    // The file has left the vault; only the sweep it still owes remains.
    expect(readablePathOf("raw/gone.csv", { hash: CASCADE_PENDING, derivative: "raw/gone.md" })).toBe(
      null,
    );
  });
});
