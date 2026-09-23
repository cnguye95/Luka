// The retrieval pipeline and the mode predicate: among these are mode
// predicate boundaries, and assembly budget and truncation.
import { describe, expect, it } from "vitest";
import {
  forceIncludeSeeds,
  modeOf,
  rankByScores,
  rankModeA,
  rankModeB,
  selectSeeds,
} from "../src/core/retrieve/pipeline";
import { assemble } from "../src/core/retrieve/assemble";
import { DEFAULT_SETTINGS, type GraphSnapshot, type PageMeta } from "../src/core/types";
import { MemFs } from "./helpers/memfs";
import { StubProvider } from "./helpers/provider";

// Stated here rather than read from the code they check.
const FIXED_MIN_NODES = 20;
const FIXED_MIN_RATIO = 1.5;
const FIXED_K = 12;

const meta = (title: string, over: Partial<PageMeta> = {}): PageMeta => ({
  path: `wiki/concepts/${title}.md`,
  title,
  kind: "concept",
  aliases: [],
  summary: "",
  updated: "2026-08-20",
  ...over,
});

function graphOf(nodes: number, edges: number): GraphSnapshot {
  const path = (at: number) => `wiki/concepts/n${String(at).padStart(3, "0")}.md`;
  const list: GraphSnapshot["edges"] = [];
  outer: for (let a = 0; a < nodes; a++) {
    for (let b = a + 1; b < nodes; b++) {
      if (list.length === edges) break outer;
      list.push({ a: path(a), b: path(b) });
    }
  }
  return {
    nodes: Array.from({ length: nodes }, (_unused, at) => ({
      path: path(at),
      title: `n${at}`,
      kind: "concept" as const,
      degree: 0,
      summary: "",
    })),
    edges: list,
  };
}

describe("the mode predicate, at its boundaries", () => {
  const mode = (nodes: number, edges: number) => modeOf(graphOf(nodes, edges), DEFAULT_SETTINGS);

  it("needs both halves, not either", () => {
    // Enough nodes but too sparse.
    expect(mode(FIXED_MIN_NODES, Math.ceil(FIXED_MIN_NODES * FIXED_MIN_RATIO) - 1)).toBe("A");
    // Dense enough but too few nodes.
    expect(mode(FIXED_MIN_NODES - 1, (FIXED_MIN_NODES - 1) * 3)).toBe("A");
  });

  it("is inclusive on both thresholds", () => {
    // "node count ≥ 20 AND … ≥ 1.5" — exactly at both is Mode B.
    expect(mode(FIXED_MIN_NODES, FIXED_MIN_NODES * FIXED_MIN_RATIO)).toBe("B");
    expect(mode(FIXED_MIN_NODES - 1, (FIXED_MIN_NODES - 1) * FIXED_MIN_RATIO)).toBe("A");
  });

  it("reads one edge below the ratio as Mode A", () => {
    expect(mode(FIXED_MIN_NODES, FIXED_MIN_NODES * FIXED_MIN_RATIO - 1)).toBe("A");
  });

  it("calls an empty vault Mode A rather than dividing by zero", () => {
    expect(modeOf({ nodes: [], edges: [] }, DEFAULT_SETTINGS)).toBe("A");
  });
});

describe("the seed call", () => {
  const pages = [meta("PageRank"), meta("Retrieval")];
  const index = "# Index\n- [[PageRank]]\n- [[Retrieval]]\n";
  const caps = { seeds: 8, keywords: 12 };

  const ask = (reply: unknown) =>
    selectSeeds(new StubProvider(() => reply), "How does ranking work?", index, pages, caps);

  it("drops a path the model invented", async () => {
    const chosen = await ask({
      seeds: ["wiki/concepts/PageRank.md", "wiki/concepts/Nonexistent.md"],
      keywords: ["ranking"],
    });

    expect(chosen.seeds).toEqual(["wiki/concepts/PageRank.md"]);
  });

  it("caps what the model returns", async () => {
    const chosen = await selectSeeds(
      new StubProvider(() => ({
        seeds: pages.map((page) => page.path),
        keywords: ["a", "b", "c"],
      })),
      "q",
      index,
      pages,
      { seeds: 1, keywords: 2 },
    );

    expect(chosen.seeds).toHaveLength(1);
    expect(chosen.keywords).toEqual(["a", "b"]);
  });

  it("drops duplicates and blanks rather than spending the cap on them", async () => {
    const chosen = await ask({
      seeds: ["wiki/concepts/PageRank.md", "wiki/concepts/PageRank.md"],
      keywords: ["ranking", "   ", "ranking", "walks"],
    });

    expect(chosen.seeds).toEqual(["wiki/concepts/PageRank.md"]);
    expect(chosen.keywords).toEqual(["ranking", "walks"]);
  });

  it("tolerates a reply whose lists are missing or wrongly typed", async () => {
    expect(await ask({})).toEqual({ seeds: [], keywords: [] });
    expect(await ask({ seeds: "PageRank", keywords: 7 })).toEqual({ seeds: [], keywords: [] });
    expect(await ask({ seeds: [1, null, {}], keywords: [] })).toEqual({ seeds: [], keywords: [] });
  });

  it("refuses a reply that is not an object at all", async () => {
    await expect(ask(["PageRank"])).rejects.toThrow(/JSON object/);
  });

  it("asks the seed-selection task, in JSON mode, with the index in the prompt", async () => {
    const provider = new StubProvider(() => ({ seeds: [], keywords: [] }));
    await selectSeeds(provider, "How does ranking work?", index, pages, caps);

    const call = provider.callsFor("seed-selection")[0];
    expect(call?.user).toContain("How does ranking work?");
    expect(call?.user).toContain("[[PageRank]]");
    // JSON tasks run at temperature 0.
    expect(call?.temperature).toBe(0);
  });
});

describe("force-inclusion", () => {
  const pages = [
    meta("PageRank", { aliases: ["PPR"] }),
    meta("Graph Retrieval"),
    meta("Photosynthesis"),
  ];

  it("includes a page the question names by title", () => {
    expect(forceIncludeSeeds("what is pagerank for?", pages)).toEqual([
      "wiki/concepts/PageRank.md",
    ]);
  });

  it("includes a page the question names by alias", () => {
    expect(forceIncludeSeeds("explain PPR", pages)).toEqual(["wiki/concepts/PageRank.md"]);
  });

  it("matches case-insensitively and returns paths in code-point order", () => {
    expect(forceIncludeSeeds("GRAPH RETRIEVAL and pagerank", pages)).toEqual([
      "wiki/concepts/Graph Retrieval.md",
      "wiki/concepts/PageRank.md",
    ]);
  });

  it("includes nothing when the question names nothing", () => {
    expect(forceIncludeSeeds("what is the weather", pages)).toEqual([]);
  });
});

describe("ranking", () => {
  // Fed a hand-written score map rather than a walk: the point of the split is
  // that ranking is a pure function of scores, and deriving the input from
  // `computePPR` would make this agree with whatever the walk does.
  it("ranks the nodes a walk reached, carrying title and kind from the graph", () => {
    const graph: GraphSnapshot = {
      nodes: [
        { path: "raw/paper.md", title: "paper.md", kind: "raw", degree: 1, summary: "" },
        { path: "wiki/concepts/A.md", title: "A", kind: "concept", degree: 1, summary: "" },
        { path: "wiki/concepts/Z.md", title: "Z", kind: "concept", degree: 0, summary: "" },
      ],
      edges: [{ a: "raw/paper.md", b: "wiki/concepts/A.md" }],
    };

    const ranked = rankByScores(
      graph,
      // `Z` was reached with nothing and `ghost` is not on the graph at all.
      new Map([
        ["raw/paper.md", 0.5],
        ["wiki/concepts/A.md", 0.2],
        ["wiki/concepts/Z.md", 0],
        ["wiki/concepts/ghost.md", 0.9],
      ]),
    );

    expect(ranked).toEqual([
      { path: "raw/paper.md", title: "paper.md", kind: "raw", score: 0.5 },
      { path: "wiki/concepts/A.md", title: "A", kind: "concept", score: 0.2 },
    ]);
  });

  it("breaks a tie lexicographically by path", () => {
    const graph: GraphSnapshot = {
      nodes: [
        { path: "wiki/concepts/B.md", title: "B", kind: "concept", degree: 0, summary: "" },
        { path: "wiki/concepts/A.md", title: "A", kind: "concept", degree: 0, summary: "" },
      ],
      edges: [],
    };

    const tied = new Map([
      ["wiki/concepts/A.md", 0.25],
      ["wiki/concepts/B.md", 0.25],
    ]);

    expect(rankByScores(graph, tied).map((node) => node.path)).toEqual([
      "wiki/concepts/A.md",
      "wiki/concepts/B.md",
    ]);
  });

  it("Mode B ranks raw source nodes alongside wiki pages", async () => {
    const graph: GraphSnapshot = {
      nodes: [
        { path: "raw/paper.md", title: "paper.md", kind: "raw", degree: 1, summary: "" },
        { path: "wiki/concepts/A.md", title: "A", kind: "concept", degree: 1, summary: "" },
      ],
      edges: [{ a: "raw/paper.md", b: "wiki/concepts/A.md" }],
    };

    const ranked = rankModeB(graph, ["wiki/concepts/A.md"], DEFAULT_SETTINGS);

    expect(ranked.map((node) => node.path)).toContain("raw/paper.md");
    expect(ranked.find((node) => node.path === "raw/paper.md")?.kind).toBe("raw");
  });

  it("Mode B drops a node the walk never reached", () => {
    const graph: GraphSnapshot = {
      nodes: [
        { path: "wiki/concepts/A.md", title: "A", kind: "concept", degree: 0, summary: "" },
        { path: "wiki/concepts/Z.md", title: "Z", kind: "concept", degree: 0, summary: "" },
      ],
      edges: [],
    };

    expect(rankModeB(graph, ["wiki/concepts/A.md"], DEFAULT_SETTINGS).map((n) => n.path)).toEqual([
      "wiki/concepts/A.md",
    ]);
  });

  it("Mode A ranks wiki pages only, and keeps a seed no keyword touches", async () => {
    const fs = new MemFs({
      "wiki/concepts/PageRank.md": "---\nkind: concept\n---\nAbout ranking.\n",
      "wiki/concepts/Chosen.md": "---\nkind: concept\n---\nUnrelated prose.\n",
    });
    const pages = [meta("PageRank"), meta("Chosen")];

    const ranked = await rankModeA(fs, pages, ["wiki/concepts/Chosen.md"], ["PageRank"]);

    // The model chose `Chosen` from the index — a judgement the lexical score
    // cannot express — so it stays a candidate at score 0.
    expect(ranked.map((node) => node.path)).toEqual([
      "wiki/concepts/PageRank.md",
      "wiki/concepts/Chosen.md",
    ]);
    expect(ranked[1]?.score).toBe(0);
  });

  it("breaks ties lexicographically", async () => {
    const fs = new MemFs({
      "wiki/concepts/Beta.md": "---\nkind: concept\n---\nranking\n",
      "wiki/concepts/Alpha.md": "---\nkind: concept\n---\nranking\n",
    });

    const ranked = await rankModeA(fs, [meta("Beta"), meta("Alpha")], [], ["ranking"]);

    expect(ranked.map((node) => node.path)).toEqual([
      "wiki/concepts/Alpha.md",
      "wiki/concepts/Beta.md",
    ]);
  });
});

describe("assembly under the budget", () => {
  const ranked = (paths: string[]) =>
    paths.map((path, at) => ({ path, title: path, kind: "concept" as const, score: 100 - at }));

  it("takes whole nodes in rank order", async () => {
    const fs = new MemFs({
      "a.md": "---\nkind: concept\n---\nAlpha body.\n",
      "b.md": "---\nkind: concept\n---\nBeta body.\n",
    });

    const assembly = await assemble(fs, ranked(["a.md", "b.md"]), 40_000, FIXED_K);

    expect(assembly.nodes.map((node) => node.path)).toEqual(["a.md", "b.md"]);
    expect(assembly.nodes[0]?.text.trim()).toBe("Alpha body.");
    // Frontmatter is stripped: it is code-written scaffolding, not grounding.
    expect(assembly.nodes[0]?.text).not.toContain("kind: concept");
    expect(assembly.nodes.every((node) => !node.truncated)).toBe(true);
  });

  it("stops at K however many nodes rank", async () => {
    const seed: Record<string, string> = {};
    const paths: string[] = [];
    for (let at = 0; at < FIXED_K + 5; at++) {
      const path = `n${String(at).padStart(2, "0")}.md`;
      seed[path] = `---\nkind: concept\n---\nBody ${at}.\n`;
      paths.push(path);
    }

    const fs = new MemFs(seed);
    const assembly = await assemble(fs, ranked(paths), 40_000, FIXED_K);

    expect(assembly.nodes).toHaveLength(FIXED_K);
    // And stops *reading* there too. `packUnderBudget` would cap the output
    // either way, so without this the pipeline would quietly read every page
    // in the vault to assemble twelve of them.
    expect(fs.reads).toBe(FIXED_K);
  });

  it("never splits a page: it stops at the first that does not fit", async () => {
    const fs = new MemFs({
      "a.md": `---\nkind: concept\n---\n${"alpha ".repeat(50)}\n`,
      "b.md": `---\nkind: concept\n---\n${"beta ".repeat(50)}\n`,
    });

    // Room for the first and not the second (each ~300 chars ≈ 75 tokens).
    const assembly = await assemble(fs, ranked(["a.md", "b.md"]), 100, FIXED_K);

    expect(assembly.nodes.map((node) => node.path)).toEqual(["a.md"]);
    expect(assembly.nodes[0]?.truncated).toBe(false);
  });

  it("tail-truncates a single page over the whole budget, with the marker", async () => {
    const fs = new MemFs({ "a.md": `---\nkind: concept\n---\n${"alpha ".repeat(500)}\n` });

    const assembly = await assemble(fs, ranked(["a.md"]), 50, FIXED_K);

    expect(assembly.nodes).toHaveLength(1);
    expect(assembly.nodes[0]?.truncated).toBe(true);
    expect(assembly.nodes[0]?.text).toContain("truncated for context budget");
  });

  it("skips a node whose file has gone missing since it was ranked", async () => {
    const fs = new MemFs({ "b.md": "---\nkind: concept\n---\nBeta body.\n" });

    const assembly = await assemble(fs, ranked(["gone.md", "b.md"]), 40_000, FIXED_K);

    expect(assembly.nodes.map((node) => node.path)).toEqual(["b.md"]);
  });

  it("skips a node with no body to contribute", async () => {
    const fs = new MemFs({
      "empty.md": "---\nkind: concept\n---\n\n",
      "b.md": "---\nkind: concept\n---\nBeta body.\n",
    });

    const assembly = await assemble(fs, ranked(["empty.md", "b.md"]), 40_000, FIXED_K);

    expect(assembly.nodes.map((node) => node.path)).toEqual(["b.md"]);
  });
});
