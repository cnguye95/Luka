// The retrieval graph (handoff.md §7.1), and invariant 8's exclusion of
// `_`-prefixed infrastructure from the node set.
import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/core/graph/build";
import { createCore } from "../src/core/index";
import { DEFAULT_SETTINGS, type GraphSnapshot } from "../src/core/types";
import { CASCADE_PENDING } from "../src/core/manifest";
import { comparePaths } from "../src/core/paths";
import { StubHttp } from "./helpers/http";
import { MemFs } from "./helpers/memfs";
import { StubProvider, inventoryReply } from "./helpers/provider";

const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";

function page(_title: string, kind: string, body: string, aliases: string[] = []): string {
  const aliasLine = aliases.length === 0 ? "" : `aliases:\n${aliases.map((a) => `  - ${a}\n`).join("")}`;
  return `---\nkind: ${kind}\n${aliasLine}summary: ''\nupdated: '2026-08-20'\n---\n${body}\n`;
}

const build = (fs: MemFs) => buildGraph({ fs, manifestPath: MANIFEST });

const nodePaths = (graph: GraphSnapshot) => graph.nodes.map((n) => n.path);
const pairs = (graph: GraphSnapshot) => graph.edges.map((e) => `${e.a}|${e.b}`);

describe("the node set (§7.1)", () => {
  it("takes wiki pages and every manifest source's readable markdown", async () => {
    const fs = new MemFs({
      "wiki/concepts/PageRank.md": page("PageRank", "concept", "Body."),
      "wiki/sources/paper.md": page("paper", "source", "Body."),
      "raw/note.md": "A passthrough source.\n",
      "raw/paper.md": "---\nderived-from: raw/paper.pdf\n---\nExtracted.\n",
      "raw/paper.pdf": "%PDF-1.4\n",
      [MANIFEST]: JSON.stringify({
        "raw/note.md": { hash: "a" },
        "raw/paper.pdf": { hash: "b", derivative: "raw/paper.md" },
      }),
    });

    const graph = await build(fs);

    // The PDF is not a node; the markdown extracted from it is (§7.1's
    // "the source itself if `.md`/`.txt`, else its derivative").
    expect(nodePaths(graph)).toEqual([
      "raw/note.md",
      "raw/paper.md",
      "wiki/concepts/PageRank.md",
      "wiki/sources/paper.md",
    ]);
  });

  it("gives a raw node its basename as a title", async () => {
    const fs = new MemFs({
      "raw/deep/folder/notes.md": "Body.\n",
      [MANIFEST]: JSON.stringify({ "raw/deep/folder/notes.md": { hash: "a" } }),
    });

    const graph = await build(fs);

    expect(graph.nodes[0]).toMatchObject({ title: "notes.md", kind: "raw" });
  });

  it("excludes a source whose cascade is still pending", async () => {
    // A pending entry is a source that left the vault. There is no file, so
    // there is no node.
    const fs = new MemFs({
      "raw/here.md": "Body.\n",
      [MANIFEST]: JSON.stringify({
        "raw/here.md": { hash: "a" },
        "raw/gone.md": { hash: CASCADE_PENDING, derivative: "raw/gone.md" },
      }),
    });

    expect(nodePaths(await build(fs))).toEqual(["raw/here.md"]);
  });

  it("excludes `_`-prefixed infrastructure (invariant 8)", async () => {
    const fs = new MemFs({
      "wiki/_index.md": "# Index\n- [[PageRank]]\n",
      "wiki/concepts/PageRank.md": page("PageRank", "concept", "Body."),
      [MANIFEST]: "{}",
    });

    const graph = await build(fs);

    expect(nodePaths(graph)).toEqual(["wiki/concepts/PageRank.md"]);
    // "never graph nodes, never edge sources" — the index links to PageRank,
    // and that link contributes nothing.
    expect(graph.edges).toEqual([]);
  });
});

describe("edges (§7.1)", () => {
  it("draws them from the body, the citation block and frontmatter source:", async () => {
    const fs = new MemFs({
      // Body link.
      "wiki/concepts/PageRank.md": page("PageRank", "concept", "Relates to [[Graph Retrieval]]."),
      "wiki/concepts/Graph Retrieval.md": page("Graph Retrieval", "concept", "Body."),
      // Frontmatter `source:` link, and a citation block link.
      "wiki/sources/note.md":
        "---\nkind: source\nsource: \"[[raw/note.md]]\"\nsummary: ''\nupdated: '2026-08-20'\n---\n" +
        "Prose.\n<!-- citations:start -->\n## Sources\n- [[raw/note.md]]\n<!-- citations:end -->\n",
      "raw/note.md": "A source.\n",
      [MANIFEST]: JSON.stringify({ "raw/note.md": { hash: "a" } }),
    });

    const graph = await build(fs);

    expect(pairs(graph)).toEqual([
      "raw/note.md|wiki/sources/note.md",
      "wiki/concepts/Graph Retrieval.md|wiki/concepts/PageRank.md",
    ]);
  });

  it("reaches a derivative's node by the manifest path its citers name", async () => {
    // A source page cites `raw/paper.pdf` — the manifest path — while the node
    // is the markdown extracted from it. Without the alias the page would have
    // no edge to the very file it describes.
    const fs = new MemFs({
      "wiki/sources/paper.md":
        "---\nkind: source\nsource: \"[[raw/paper.pdf]]\"\nsummary: ''\nupdated: '2026-08-20'\n---\nProse.\n",
      "raw/paper.md": "---\nderived-from: raw/paper.pdf\n---\nExtracted.\n",
      [MANIFEST]: JSON.stringify({ "raw/paper.pdf": { hash: "b", derivative: "raw/paper.md" } }),
    });

    expect(pairs(await build(fs))).toEqual(["raw/paper.md|wiki/sources/paper.md"]);
  });

  it("deduplicates a pair however many times it is linked", async () => {
    const fs = new MemFs({
      "wiki/concepts/A.md": page("A", "concept", "[[B]] and [[B]] and [[B|bee]]."),
      "wiki/concepts/B.md": page("B", "concept", "Back to [[A]]."),
      [MANIFEST]: "{}",
    });

    const graph = await build(fs);

    expect(pairs(graph)).toEqual(["wiki/concepts/A.md|wiki/concepts/B.md"]);
    expect(graph.nodes.map((n) => n.degree)).toEqual([1, 1]);
  });

  it("contributes nothing for a link that resolves to no node", async () => {
    const fs = new MemFs({
      "wiki/concepts/A.md": page("A", "concept", "[[Nobody]] and [[A#Section]] and [[A]]."),
      [MANIFEST]: "{}",
    });

    const graph = await build(fs);

    // Unresolved, a heading reference, and a self-link: none is an edge.
    expect(graph.edges).toEqual([]);
    expect(graph.nodes[0]?.degree).toBe(0);
  });

  it("does not resolve a heading reference, even to a raw file named for one", async () => {
    // A wiki title can never hold `#` — `sanitizeTitle` strips it — so this
    // guard is only reachable through a raw path, where it costs something:
    // a source called `C#.md` cannot be linked into. That matches
    // `resolveLinks`, and one rule for what a `#` means is worth more than
    // reaching one awkwardly-named file.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("A", "concept", "See [[raw/C#.md]] and [[raw/plain.md]]."),
      "raw/C#.md": "A source.\n",
      "raw/plain.md": "Another.\n",
      [MANIFEST]: JSON.stringify({ "raw/C#.md": { hash: "a" }, "raw/plain.md": { hash: "b" } }),
    });

    const graph = await build(fs);

    expect(nodePaths(graph)).toContain("raw/C#.md");
    expect(pairs(graph)).toEqual(["raw/plain.md|wiki/concepts/A.md"]);
  });

  it("resolves an alias to the page that holds it", async () => {
    const fs = new MemFs({
      "wiki/concepts/Personalized PageRank.md": page("Personalized PageRank", "concept", "Body.", ["PPR"]),
      "wiki/concepts/Retrieval.md": page("Retrieval", "concept", "Uses [[PPR]]."),
      [MANIFEST]: "{}",
    });

    expect(pairs(await build(fs))).toEqual([
      "wiki/concepts/Personalized PageRank.md|wiki/concepts/Retrieval.md",
    ]);
  });
});

describe("the graph does not depend on the order the vault is read in", () => {
  it("is identical when the same files arrive in a different order", async () => {
    const seed: Record<string, string> = {
      "wiki/concepts/A.md": page("A", "concept", "[[B]] [[C]]"),
      "wiki/concepts/B.md": page("B", "concept", "[[C]]"),
      "wiki/concepts/C.md": page("C", "concept", "Body."),
      "raw/n.md": "A source.\n",
      [MANIFEST]: JSON.stringify({ "raw/n.md": { hash: "a" } }),
    };
    // Two builds cannot be made to disagree here, and that is the point worth
    // stating rather than dressing up: `loadPageTable` sorts its own result and
    // the manifest keys are sorted before use, so `build.ts` sees the same
    // input order whatever the adapter hands back. The first version of this
    // test reversed a seed map and compared a build against itself — it passed
    // with every sort in `build.ts` deleted.
    //
    // What is observable, and what a caller depends on, is that the output is
    // ordered. §7.2 ranks over `graph.nodes` and expects "node order
    // lexicographic by path".
    const graph = await build(new MemFs(seed));

    expect(graph.nodes.map((node) => node.path)).toEqual(
      [...graph.nodes.map((node) => node.path)].sort(comparePaths),
    );
    expect(graph.edges.map((edge) => `${edge.a}|${edge.b}`)).toEqual(
      [...graph.edges].sort((a, b) => comparePaths(a.a, b.a) || comparePaths(a.b, b.b))
        .map((edge) => `${edge.a}|${edge.b}`),
    );
    // Every edge is canonicalized, so an edge list is order-independent even
    // before it is sorted.
    for (const edge of graph.edges) expect(comparePaths(edge.a, edge.b)).toBeLessThan(0);
  });
});

describe("the graph is rebuilt after compile (§7.1)", () => {
  it("fires the rebuild callback and answers getGraph from the new vault", async () => {
    const fs = new MemFs({ "raw/note.md": "PageRank matters.\n" });
    const provider = new StubProvider((request) =>
      request.task === "page-generation"
        ? "Prose about [[PageRank]]."
        : inventoryReply("A note.", [{ title: "PageRank", kind: "concept" }]),
    );
    const core = createCore({
      fs,
      http: new StubHttp({}),
      manifestPath: MANIFEST,
      settings: { ...DEFAULT_SETTINGS, apiKey: "test-key" },
      now: () => new Date("2026-08-20T10:00:00Z"),
      provider,
    });

    const seen: GraphSnapshot[] = [];
    const unsubscribe = core.onGraphRebuilt((graph) => seen.push(graph));

    // §5: the callback fires "after compile and after load". The first build
    // is the load-time one, and the vault has nothing in it yet.
    expect((await core.getGraph()).nodes).toEqual([]);
    expect(seen).toHaveLength(1);

    await core.compile();

    expect(seen).toHaveLength(2);
    const after = await core.getGraph();
    expect(after.nodes.length).toBeGreaterThan(0);
    // Served from cache, not rebuilt again.
    expect(after).toBe(seen[1]);

    unsubscribe();
    await core.compile();
    expect(seen).toHaveLength(2);
  });
});
