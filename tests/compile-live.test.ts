// Opt-in end-to-end compile against the real Anthropic API.
//
// Runs ONLY when ANTHROPIC_API_KEY is set:
//   ANTHROPIC_API_KEY=sk-ant-... npx vitest run tests/compile-live.test.ts
// CI never sets it. This is the functionality test for M2c: it proves that
// real model replies — not stub shapes — survive Call A's JSON validation,
// the merge, Call B, and the post-process into a wiki that parses back.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCitationBlock } from "../src/core/compile/citations";
import { loadPageTable } from "../src/core/compile/pagetable";
import { createCore } from "../src/core/index";
import { DEFAULT_SETTINGS } from "../src/core/types";
import { NodeFs } from "../eval/nodefs";
import { NodeHttp } from "../eval/nodehttp";
import { StubHttp } from "./helpers/http";

const key = process.env["ANTHROPIC_API_KEY"];
const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";

const SOURCE = `# Personalized PageRank

Personalized PageRank (PPR) ranks nodes by the stationary distribution of a
random walk that restarts at a chosen seed set. Luka uses it over the wikilink
graph in Obsidian, which avoids needing a vector database entirely.
`;

describe.skipIf(!key)("live compile (opt-in: set ANTHROPIC_API_KEY)", () => {
  let vault: string;

  afterAll(async () => {
    if (vault) await rm(vault, { recursive: true, force: true });
  });

  it("compiles one real source into a wiki", { timeout: 240_000 }, async () => {
    vault = await mkdtemp(path.join(tmpdir(), "luka-live-"));
    const fs = new NodeFs(vault);
    await fs.mkdir("raw");
    await fs.write("raw/ppr.md", SOURCE);

    const core = createCore({
      fs,
      // Real transport for model calls; images are never fetched here.
      http: new NodeHttp(),
      manifestPath: MANIFEST,
      settings: { ...DEFAULT_SETTINGS, apiKey: key ?? "" },
    });

    const result = await core.compile();
    expect(result.failed).toEqual([]);
    expect(result.added).toBe(1);
    // One inventory call, plus one generation call per page the model named.
    expect(result.modelCalls).toBeGreaterThanOrEqual(1);

    const pages = await loadPageTable(fs);
    const sourcePage = pages.find((page) => page.kind === "source");
    expect(sourcePage?.source).toBe("raw/ppr.md");
    expect(sourcePage?.summary).not.toBe("");

    // Every page code wrote parses back as a page with a real citation block.
    for (const page of pages) {
      const entries = parseCitationBlock(await text(fs, page.path)).entries;
      expect(entries.length, `${page.path} has no citations`).toBeGreaterThan(0);
      for (const entry of entries) expect(await fs.exists(entry)).toBe(true);
    }

    const index = await text(fs, "wiki/_index.md");
    for (const page of pages) expect(index).toContain(`[[${page.title}]]`);
  });

  it("makes zero model calls on an immediate recompile", { timeout: 120_000 }, async () => {
    const fs = new NodeFs(vault);
    const core = createCore({
      fs,
      // A stub http adapter would fail loudly if anything tried to call out.
      http: new StubHttp({}),
      manifestPath: MANIFEST,
      settings: { ...DEFAULT_SETTINGS, apiKey: key ?? "" },
    });

    const result = await core.compile();
    expect(result.modelCalls).toBe(0);
    expect(result.noop).toBe(true);
  });
});

async function text(fs: NodeFs, target: string): Promise<string> {
  return new TextDecoder().decode(await fs.read(target));
}
