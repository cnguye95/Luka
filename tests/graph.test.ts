// The retrieval graph, and invariant 8's exclusion of
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

describe("the node set", () => {
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

    // The PDF is not a node; the markdown extracted from it is (the rule:
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

describe("a node carries its summary (the pane's tooltip)", () => {
  // The hover tooltip is "title, kind, summary". Carrying the summary on the
  // node is what lets the pane draw it without a second read of the vault —
  // the pane has no `FsAdapter` and hovering must cost no IO.
  const summarized = (kind: string, summary: string) =>
    `---\nkind: ${kind}\nsummary: ${summary}\nupdated: '2026-08-20'\n---\nBody.\n`;

  it("carries a wiki page's summary verbatim", async () => {
    const fs = new MemFs({
      "wiki/concepts/PageRank.md": summarized("concept", "A link-analysis ranking algorithm."),
      [MANIFEST]: "{}",
    });

    const graph = await build(fs);

    expect(graph.nodes[0]?.summary).toBe("A link-analysis ranking algorithm.");
  });

  it("gives a raw source node an empty summary, having no frontmatter to read", async () => {
    const fs = new MemFs({
      "raw/note.md": "A passthrough source with no frontmatter at all.\n",
      [MANIFEST]: JSON.stringify({ "raw/note.md": { hash: "a" } }),
    });

    const graph = await build(fs);

    const raw = graph.nodes.find((node) => node.kind === "raw");
    expect(raw?.path).toBe("raw/note.md");
    expect(raw?.summary).toBe("");
  });
});

describe("edges", () => {
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

  it("does not let a page alias take a manifest path away from its raw node", async () => {
    // Call A sees only the body and asks for "obvious variants", so a dataset's
    // descriptor page comes back aliased with the dataset's own path. By design
    // every citation block and `source:` key name that path; if the alias won,
    // each of them would be an edge to the wrong node and the raw node would
    // sit at degree 0, unreported because the orphan filter skips raw.
    const fs = new MemFs({
      "wiki/entities/runs.csv.md": page("runs.csv", "entity", "The dataset.", ["raw/runs.csv"]),
      "wiki/sources/runs.md":
        "---\nkind: source\nsource: \"[[raw/runs.csv]]\"\nsummary: ''\nupdated: '2026-08-20'\n---\nProse.\n",
      "raw/runs.md": "---\nderived-from: raw/runs.csv\n---\n# runs.csv\n",
      [MANIFEST]: JSON.stringify({ "raw/runs.csv": { hash: "c", derivative: "raw/runs.md" } }),
    });

    expect(pairs(await build(fs))).toEqual(["raw/runs.md|wiki/sources/runs.md"]);
  });

  it("keeps a passthrough source reachable when a page alias is its own path", async () => {
    // Harder than the derivative case: the alias names the node's *own* path,
    // so both manifest claims would be no-ops if the page had claimed first,
    // and the raw node would be reachable by no name at all.
    const fs = new MemFs({
      "wiki/entities/rawfigures.md.md": page("rawfigures.md", "entity", "Figures.", ["raw/figures.md"]),
      "wiki/concepts/Image localization.md": page("Image localization", "concept", "See [[raw/figures.md]]."),
      "raw/figures.md": "![a](a.png)\n",
      [MANIFEST]: JSON.stringify({ "raw/figures.md": { hash: "f" } }),
    });

    expect(pairs(await build(fs))).toEqual(["raw/figures.md|wiki/concepts/Image localization.md"]);
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
    // ordered. PageRank ranks over `graph.nodes` and expects "node order
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

describe("the graph is rebuilt after compile", () => {
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

    // The callback fires "after compile and after load". The first build
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

  it("finishes a compile whose own rebuild cannot walk, and says so on the report", async () => {
    // Every page is written and the manifest committed before the rebuild
    // runs, so a file that cannot be read *then* is a graph problem, not a
    // compile failure. Thrown, it would reach the plugin as "compile failed"
    // and the run's own report would never be shown. The stale cache goes
    // too: the next read walks rather than serving the pre-compile vault.
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
    core.onGraphRebuilt((graph) => seen.push(graph));
    expect((await core.getGraph()).nodes).toEqual([]);

    // The manifest is the compile's commit point, and nothing reads `wiki/`
    // after it is written — except the rebuild. Fail the first such read.
    const originalRead = fs.read.bind(fs);
    const originalWrite = fs.write.bind(fs);
    let committed = false;
    fs.write = async (path: string, data) => {
      if (path === MANIFEST) committed = true;
      return originalWrite(path, data);
    };
    fs.read = async (path: string) => {
      if (committed && path.startsWith("wiki/")) {
        committed = false;
        throw new Error("EACCES wiki/");
      }
      return originalRead(path);
    };

    const result = await core.compile();

    expect(result.failed).toEqual([]);
    expect(result.pagesWritten).toBeGreaterThan(0);
    expect(result.reported.map((entry) => entry.reason)).toEqual([
      expect.stringMatching(/^graph not rebuilt — EACCES wiki\//),
    ]);
    // Nothing was published for the walk that failed, and the next read walks
    // the vault the compile left rather than the empty one it began with.
    expect(seen).toHaveLength(1);
    expect((await core.getGraph()).nodes.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(2);
  });
});

describe("a forced read walks the vault again (the pane's Refresh)", () => {
  const coreOver = (fs: MemFs) =>
    createCore({
      fs,
      http: new StubHttp({}),
      manifestPath: MANIFEST,
      settings: { ...DEFAULT_SETTINGS, apiKey: "test-key" },
      provider: new StubProvider(() => ""),
    });

  it("re-reads a vault that changed underneath the cache, and publishes what it finds", async () => {
    // The finding: a page written into `wiki/` from outside Obsidian left
    // the pane's counts unchanged, because nothing could make `getGraph`
    // re-walk. Both halves matter — the cache still answers the unforced call
    // ("opens under a second"), and the forced one sees the new page.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("A", "concept", "Body."),
      [MANIFEST]: "{}",
    });
    const core = coreOver(fs);
    const seen: GraphSnapshot[] = [];
    core.onGraphRebuilt((graph) => seen.push(graph));

    const first = await core.getGraph();
    expect(nodePaths(first)).toEqual(["wiki/concepts/A.md"]);
    expect(seen).toHaveLength(1);

    // Written straight to the vault, the way a sync or another window does it:
    // no compile runs here, so no rebuild event fires.
    await fs.write("wiki/concepts/B.md", page("B", "concept", "Links [[A]]."));
    expect(await core.getGraph()).toBe(first);

    const forced = await core.getGraph({ force: true });

    expect(nodePaths(forced)).toEqual(["wiki/concepts/A.md", "wiki/concepts/B.md"]);
    expect(pairs(forced)).toEqual(["wiki/concepts/A.md|wiki/concepts/B.md"]);
    // Published, so a pane listening rather than awaiting hears about it too.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(forced);
    // And cached, so the next unforced read does not walk a third time.
    expect(await core.getGraph()).toBe(forced);
  });

  it("retires a walk already in flight rather than joining it", async () => {
    // `rebuildGraph` collapses concurrent callers onto one walk. Without the
    // retire, a forced read would join a walk that began before the vault
    // moved and answer Refresh with the very snapshot it was asked to replace.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("A", "concept", "Body."),
      [MANIFEST]: "{}",
    });
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parkedOnce = false;
    const originalRead = fs.read.bind(fs);
    fs.read = async (path: string) => {
      // Only the first walk parks; the forced one must be free to overtake it.
      if (!parkedOnce && path === MANIFEST) {
        parkedOnce = true;
        await parked;
      }
      return originalRead(path);
    };

    const core = coreOver(fs);
    const seen: GraphSnapshot[] = [];
    core.onGraphRebuilt((graph) => seen.push(graph));

    const stale = core.getGraph();
    while (!parkedOnce) await new Promise((resolve) => setTimeout(resolve, 0));
    await fs.write("wiki/concepts/B.md", page("B", "concept", "Links [[A]]."));

    const forced = core.getGraph({ force: true });
    release();
    const fresh = await forced;
    await stale;

    expect(nodePaths(fresh)).toEqual(["wiki/concepts/A.md", "wiki/concepts/B.md"]);
    // The superseded walk published nothing and cached nothing: one event, from
    // the forced build, and the cache answers with it afterwards. (Its own
    // caller may still be handed what it walked — `currentOrNewer` falls back
    // to that rather than to `null` while no snapshot is cached yet.)
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(fresh);
    expect(await core.getGraph()).toBe(fresh);
  });

  it("refreshes again, and again, as a button must", async () => {
    // The slot that collapses two simultaneous presses has to be released
    // afterwards, or the second press ever made returns the first press's
    // answer — a Refresh that cannot refresh, which is the finding this
    // whole path exists to close, reintroduced one layer up.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("A", "concept", "Body."),
      [MANIFEST]: "{}",
    });
    const core = coreOver(fs);
    await core.getGraph();

    await fs.write("wiki/concepts/B.md", page("B", "concept", "Links [[A]]."));
    const second = await core.getGraph({ force: true });
    expect(nodePaths(second)).toEqual(["wiki/concepts/A.md", "wiki/concepts/B.md"]);

    await fs.write("wiki/concepts/C.md", page("C", "concept", "Links [[A]]."));
    const third = await core.getGraph({ force: true });

    expect(nodePaths(third)).toEqual([
      "wiki/concepts/A.md",
      "wiki/concepts/B.md",
      "wiki/concepts/C.md",
    ]);
  });

  it("refreshes again after a walk that failed", async () => {
    // The slot is released in a `finally`, so the press after an unreadable
    // file still walks. Released only on success, one bad file would kill the
    // button for the rest of the session.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("A", "concept", "Body."),
      [MANIFEST]: "{}",
    });
    const core = coreOver(fs);
    await core.getGraph();

    // `loadPageTable` reads each page without a guard, which is the way a
    // walk actually rejects — one unreadable file under `wiki/`.
    const originalRead = fs.read.bind(fs);
    let failNext = true;
    fs.read = async (path: string) => {
      if (failNext && path.startsWith("wiki/")) {
        failNext = false;
        throw new Error("EACCES wiki/");
      }
      return originalRead(path);
    };

    await expect(core.getGraph({ force: true })).rejects.toThrow(/EACCES/);

    await fs.write("wiki/concepts/B.md", page("B", "concept", "Links [[A]]."));
    const after = await core.getGraph({ force: true });

    expect(nodePaths(after)).toContain("wiki/concepts/B.md");
  });

  it("joins two presses onto one walk, and answers the first with what it read", async () => {
    // Refresh is a button, and a button gets pressed twice. Forcing retires
    // the in-flight slot before it asks — that is what makes it a refresh —
    // so without a slot of its own the second press retires the first, whose
    // walk then loses its generation and is handed the *pre-refresh* cache by
    // `currentOrNewer`: an answer older than the vault it asked about, plus a
    // second walk of the whole vault for one gesture.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("A", "concept", "Body."),
      [MANIFEST]: "{}",
    });
    const core = coreOver(fs);
    const stale = await core.getGraph();
    await fs.write("wiki/concepts/B.md", page("B", "concept", "Links [[A]]."));

    // Park the walk both presses should share, so they are provably concurrent.
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let manifestReads = 0;
    const originalRead = fs.read.bind(fs);
    fs.read = async (path: string) => {
      if (path === MANIFEST) {
        manifestReads += 1;
        await parked;
      }
      return originalRead(path);
    };

    const first = core.getGraph({ force: true });
    const second = core.getGraph({ force: true });
    while (manifestReads === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    release();

    const [one, two] = [await first, await second];

    // One walk: the manifest is read once, not once per press.
    expect(manifestReads).toBe(1);
    // And the first press is told about the page it pressed the button for.
    expect(nodePaths(one)).toEqual(["wiki/concepts/A.md", "wiki/concepts/B.md"]);
    expect(two).toBe(one);
    expect(one).not.toBe(stale);
  });

  it("publishes nothing from a walk that overlapped the writes", async () => {
    // The manifest is committed last, so for the whole write phase `wiki/` and
    // the manifest describe different moments, and a walk reading both sees a
    // vault that never existed. It is free to run — nothing blocks a reader —
    // but it must not become the answer anyone else is given. The compile
    // retires the generation at both edges of its write phase, so the question
    // "did this overlap the writes" is asked when the walk lands rather than
    // when it starts, which is the only moment it can be answered.
    const fs = new MemFs({ "raw/note.md": "PageRank matters for ranking.\n" });
    const replies = (request: { task: string }) =>
      request.task === "page-generation"
        ? "Prose about [[PageRank]]."
        : inventoryReply("A note about ranking.", [{ title: "PageRank", kind: "concept" }]);

    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parkedOnce = false;
    // Inventory is the first model call after the write phase opens, so
    // parking there parks the compile mid-write.
    const stalling = new StubProvider(async (request) => {
      if (request.task === "inventory" && !parkedOnce) {
        parkedOnce = true;
        await parked;
      }
      return replies(request);
    });

    const core = createCore({
      fs,
      http: new StubHttp({}),
      manifestPath: MANIFEST,
      settings: { ...DEFAULT_SETTINGS, apiKey: "test-key" },
      provider: stalling,
    });

    const warm = await core.getGraph();
    const seen: GraphSnapshot[] = [];
    core.onGraphRebuilt((graph) => seen.push(graph));

    const compiling = core.compile();
    // Waiting on the lock is too early: it is taken before discovery, and the
    // write phase does not open until the preview gate is past. Parking at the
    // first inventory call is the signal that writes are actually in flight.
    while (!parkedOnce) await new Promise((resolve) => setTimeout(resolve, 0));

    const during = await core.getGraph({ force: true });

    // It walked — this is not a refusal — and it published nothing.
    expect(seen).toHaveLength(0);
    // A reader is handed the cache rather than the half-written vault.
    expect(during).toBe(warm);
    expect(await core.getGraph()).toBe(warm);

    release();
    await compiling;

    // The compile's own rebuild is what the pane hears about.
    expect(seen).toHaveLength(1);
    expect(await core.getGraph()).not.toBe(warm);
  });

  it("reopens to refreshes after a compile that threw mid-write", async () => {
    // The write phase closes in a `finally`. Without it a failed compile
    // leaves the flag set, every later walk reads as overlapping, and nothing
    // publishes again for the rest of the session — a silence far worse than
    // the torn snapshot the flag exists to prevent.
    const fs = new MemFs({ "raw/note.md": "PageRank matters for ranking.\n" });
    const replies = (request: { task: string }) =>
      request.task === "page-generation"
        ? "Prose about [[PageRank]]."
        : inventoryReply("A note about ranking.", [{ title: "PageRank", kind: "concept" }]);
    const core = createCore({
      fs,
      http: new StubHttp({}),
      manifestPath: MANIFEST,
      settings: { ...DEFAULT_SETTINGS, apiKey: "test-key" },
      provider: new StubProvider(replies),
    });

    await core.getGraph();
    // An unguarded write, which is what actually throws out of a compile —
    // a source that merely fails is recorded and the run completes.
    const originalWrite = fs.write.bind(fs);
    fs.write = async (path: string, data: string | Uint8Array) => {
      if (path === MANIFEST) throw new Error("EACCES manifest");
      return originalWrite(path, data);
    };

    await expect(core.compile()).rejects.toThrow(/EACCES/);
    fs.write = originalWrite;

    // The vault moved while that compile was failing; a refresh must see it.
    await fs.write("wiki/concepts/B.md", page("B", "concept", "Body."));
    const seen: GraphSnapshot[] = [];
    core.onGraphRebuilt((graph) => seen.push(graph));

    const after = await core.getGraph({ force: true });

    expect(nodePaths(after)).toContain("wiki/concepts/B.md");
    expect(seen).toHaveLength(1);
    expect(await core.getGraph()).toBe(after);
  });

  it("refreshes during the scope preview, which holds the lock and writes nothing", async () => {
    // Compile holds the lock across preview, confirm and work, and the modal can
    // stay open indefinitely. Refusing to refresh for all of it would
    // reproduce the original complaint — a Refresh that returns the same numbers —
    // during the one phase where there is nothing to be wrong about.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("A", "concept", "Body."),
      [MANIFEST]: JSON.stringify({ "raw/gone.md": { hash: "a" } }),
    });
    const core = createCore({
      fs,
      http: new StubHttp({}),
      manifestPath: MANIFEST,
      settings: { ...DEFAULT_SETTINGS, apiKey: "test-key" },
      provider: new StubProvider(() => ""),
    });

    const before = await core.getGraph();

    let atModal!: () => void;
    const reached = new Promise<void>((resolve) => {
      atModal = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A source that left the vault puts the run through the preview,
    // where it waits on the answer.
    const compiling = core.compile({
      confirm: async () => {
        atModal();
        await held;
        return false;
      },
    });
    await reached;
    expect(core.busyWith).toBe("compile");

    // A page arrives from another window while the modal is open.
    await fs.write("wiki/concepts/B.md", page("B", "concept", "Links [[A]]."));
    const during = await core.getGraph({ force: true });

    expect(nodePaths(during)).toContain("wiki/concepts/B.md");
    expect(during).not.toBe(before);
    // And it is the cached answer afterwards, not a walk thrown away.
    expect(await core.getGraph()).toBe(during);

    release();
    await compiling;
  });
});
