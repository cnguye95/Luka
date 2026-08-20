import { describe, expect, it } from "vitest";
import { loadManifest, saveManifest } from "../src/core/manifest";
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

  it("drops non-string values rather than trusting them", async () => {
    const fs = new MemFs({ [PATH]: JSON.stringify({ "raw/a.md": "abc", "raw/b.md": 7 }) });
    await expect(loadManifest(fs, PATH)).resolves.toEqual({ "raw/a.md": "abc" });
  });

  it("writes sorted keys so the file does not churn between runs", async () => {
    const fs = new MemFs();
    await saveManifest(fs, PATH, { "raw/z.md": "2", "raw/a.md": "1" });
    expect(fs.text(PATH)).toBe('{\n  "raw/a.md": "1",\n  "raw/z.md": "2"\n}\n');
  });

  it("round-trips", async () => {
    const fs = new MemFs();
    const manifest = { "raw/a.md": "hash-a", "raw/sub/b.pdf": "hash-b" };
    await saveManifest(fs, PATH, manifest);
    await expect(loadManifest(fs, PATH)).resolves.toEqual(manifest);
  });
});
