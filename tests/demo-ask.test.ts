// Retrieval, ask and filing, on the demo corpus.
//
// Four behaviours: eval CI mode runs and reports; asking on the compiled demo
// vault yields an answer note whose inline links all validate; filing moves
// the note and the next compile ingests it (this test asserts its source page
// exists); the busy-lock notice.
//
// The first is `npm run eval` and `tests/eval-*.test.ts`; the last is asserted
// at core level in `ask.test.ts` and on screen by the manual checklist. The
// middle two are here, over a real filesystem with real pdf.js, because a
// stand-in vault would not be the demo corpus itself.
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCore, type CompletionRequest } from "../src/core/index";
import { buildGraph } from "../src/core/graph/build";
import { handleOf, loadPageTable } from "../src/core/compile/pagetable";
import { buildTitleIndex } from "../src/core/compile/links";
import { loadManifest } from "../src/core/manifest";
import { decodeUtf8 } from "../src/core/hash";
import { parseFrontmatter } from "../src/core/yaml";
import { DEFAULT_SETTINGS } from "../src/core/types";
import { StubHttp } from "./helpers/http";
import { NodeFs } from "../eval/nodefs";
import { StubProvider, inventoryReply } from "./helpers/provider";

const DEMO = path.resolve(import.meta.dirname, "..", "demo", "raw");
const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";
const SLOW = 30_000;

/** The synthesis reply shape: prose, then exactly one fenced JSON block. */
const answerWith = (body: string) =>
  `${body}\n\n\`\`\`json\n${JSON.stringify({ missing_information: [] })}\n\`\`\``;

describe("the ask and filing acceptance criteria, on the demo corpus", { timeout: SLOW }, () => {
  let vault: string;
  let fs: NodeFs;

  beforeEach(async () => {
    vault = await mkdtemp(path.join(tmpdir(), "luka-ask-"));
    await cp(DEMO, path.join(vault, "raw"), { recursive: true });
    fs = new NodeFs(vault);
  });

  afterEach(async () => {
    await rm(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function replyFor(request: CompletionRequest): unknown {
    if (request.task === "vision") return "A generated fixture image.";
    if (request.task === "page-generation") {
      const title = /Title: (.+)/.exec(request.user)?.[1] ?? "?";
      return `${title} is discussed by the demo corpus, alongside [[Graph Retrieval]].`;
    }
    if (request.task === "seed-selection") {
      return {
        // One real page, and one the model invented — the seed call drops it.
        seeds: ["wiki/concepts/Graph Retrieval.md", "wiki/concepts/Invented.md"],
        keywords: ["retrieval", "graph"],
      };
    }
    if (request.task === "synthesis") {
      // A link by title, a link by alias, and a link to a page that is not in
      // the retrieved set — validation must keep the first two and unlink the third.
      return answerWith(
        "Retrieval walks the graph: see [[Graph Retrieval]], sometimes written [[PPR]]. " +
          "It has nothing to do with [[Photosynthesis]].",
      );
    }
    const word = /([A-Za-z]{4,})/.exec(request.user)?.[1] ?? "Demo";
    return inventoryReply("A demo source.", [
      { title: "Graph Retrieval", kind: "concept", aliases: ["PPR"], summary: "Retrieval." },
      { title: `Topic ${word}`, kind: "entity", summary: "A topic." },
    ]);
  }

  const core = () =>
    createCore({
      fs,
      http: new StubHttp({}),
      manifestPath: MANIFEST,
      settings: { ...DEFAULT_SETTINGS, apiKey: "test-key" },
      now: () => new Date("2026-08-19T10:00:00Z"),
      provider: new StubProvider(replyFor),
    });

  const read = async (p: string) => decodeUtf8(await fs.read(p));

  it("answers with links that all validate, then files and re-ingests", async () => {
    await core().compile();

    // ── The answer ─────────────────────────────────────────────────────
    const answer = await core().ask("How does graph retrieval work?");
    const note = await read(answer.path);

    expect(answer.path).toMatch(/^answers\/2026-08-19-1000 how-does-graph-retrieval-work\.md$/);
    expect(answer.grounded).toBe(true);

    // The answer note's inline links all validate: every link left in the note
    // names something in the retrieved set.
    const { body } = parseFrontmatter(note);
    const prose = body.slice(0, body.indexOf("<!-- sources:start -->"));
    // "Validate" means each link resolves to a page that was retrieved — not
    // that it spells that page's title. Titles and aliases share one
    // namespace, so resolution goes through the same title table the vault
    // uses, and an alias is as valid a name as the title.
    const table = await loadPageTable(fs);
    const index = buildTitleIndex(table);
    const pathByTitle = new Map(table.map((page) => [handleOf(page.title), page.path]));
    const consulted = new Set(
      [...note.matchAll(/^- \[\[(.+)\]\]$/gm)]
        .map((match) => pathByTitle.get(handleOf(match[1] as string)) ?? (match[1] as string)),
    );
    const links = [...prose.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((match) =>
      (match[1] as string).trim(),
    );

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const canonical = index.get(handleOf(link));
      expect(canonical, `${link} resolves to no page in the vault`).toBeDefined();
      const resolved = pathByTitle.get(handleOf(canonical as string));
      expect(consulted.has(resolved as string), `${link} is not in the retrieved set`).toBe(true);
    }

    // The out-of-set link was unlinked, and said so.
    expect(prose).not.toContain("[[Photosynthesis]]");
    expect(prose).toContain("Photosynthesis");
    expect(prose).toContain("<!-- link outside retrieved set: Photosynthesis -->");
    // The alias link survived, resolved against the page that holds it.
    expect(prose).toContain("[[PPR]]");

    // ── Filing ─────────────────────────────────────────────────────────
    const filed = await core().fileBack(answer.path);

    expect(filed).toBe(`raw/answers/${path.basename(answer.path)}`);
    expect(await fs.exists(answer.path)).toBe(false);
    const filedText = await read(filed);
    expect(filedText).not.toContain("Retrieval trace");
    expect(filedText).toContain("## Sources consulted");

    // ── The next compile ingests it ────────────────────────────────────
    const second = await core().compile();

    expect(second.failed).toEqual([]);
    const manifest = await loadManifest(fs, MANIFEST);
    expect(Object.keys(manifest)).toContain(filed);

    // The filed answer's source page exists.
    const pages = await loadPageTable(fs);
    const sourcePage = pages.find((page) => page.source === filed);
    expect(sourcePage, "the filed answer has no source page").toBeDefined();
    expect(sourcePage?.kind).toBe("source");

    // And the sources block it kept is now graph material — which is the
    // reason filing strips the trace and not the sources.
    const graph = await buildGraph({ fs, manifestPath: MANIFEST });
    expect(graph.nodes.map((node) => node.path)).toContain(filed);
    expect(
      graph.edges.some((edge) => edge.a === filed || edge.b === filed),
      "the filed answer is an isolated node",
    ).toBe(true);
  });

  it("settles: asking changes no source, so the next compile is a no-op", async () => {
    await core().compile();
    await core().ask("How does graph retrieval work?");

    // An answer under `answers/` is not under `raw/`, so discovery never
    // sees it and compile has nothing new to do.
    const after = await core().compile();

    expect(after).toMatchObject({ noop: true, added: 0, modelCalls: 0 });
  });
});
