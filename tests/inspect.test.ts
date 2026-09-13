// "Inspect (1 model call)" — seed selection and ranking, and nothing after them.
//
// The button's label is a promise to the user, so the count is the property
// under test here, alongside invariant 2's other half: the pane is never
// blocked by the lock, so this has to answer while a compile holds it.
import { describe, expect, it } from "vitest";
import { createCore, type CompletionRequest, type CoreDeps } from "../src/core/index";
import { modeOf } from "../src/core/retrieve/pipeline";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/core/types";
import { StubHttp } from "./helpers/http";
import { MemFs } from "./helpers/memfs";
import { StubProvider, inventoryReply } from "./helpers/provider";

const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";

function replyFor(request: CompletionRequest): unknown {
  if (request.task === "seed-selection") {
    return { seeds: ["wiki/concepts/PageRank.md"], keywords: ["ranking"] };
  }
  if (request.task === "page-generation") return "Prose about [[PageRank]].";
  return inventoryReply("A note about ranking.", [
    { title: "PageRank", kind: "concept", aliases: ["PPR"], summary: "A walk." },
  ]);
}

function core(fs: MemFs, provider: StubProvider, overrides: Partial<CoreDeps> = {}) {
  return createCore({
    fs,
    http: new StubHttp({}),
    manifestPath: MANIFEST,
    settings: { ...DEFAULT_SETTINGS, apiKey: "sk-ant-secret-key" },
    provider,
    ...overrides,
  });
}

/** A compiled vault, ready to be inspected. */
async function compiled(): Promise<{ fs: MemFs; provider: StubProvider }> {
  const fs = new MemFs({ "raw/note.md": "PageRank matters for ranking.\n" });
  const provider = new StubProvider(replyFor);
  await core(fs, provider).compile();
  return { fs, provider };
}

describe("invariant 12: the label says one call, so it makes one call", () => {
  it("makes exactly one seed-selection call and no other kind", async () => {
    const { fs, provider } = await compiled();
    const before = provider.stats().byTask;

    await core(fs, provider).inspect("What ranks pages?");

    const after = provider.stats().byTask;
    expect((after["seed-selection"] ?? 0) - (before["seed-selection"] ?? 0)).toBe(1);
    // Steps 4 and 5 are what the other two of invariant 12's three calls buy.
    expect((after["synthesis"] ?? 0) - (before["synthesis"] ?? 0)).toBe(0);
    expect((after["inventory"] ?? 0) - (before["inventory"] ?? 0)).toBe(0);
    expect((after["page-generation"] ?? 0) - (before["page-generation"] ?? 0)).toBe(0);
    expect((after["vision"] ?? 0) - (before["vision"] ?? 0)).toBe(0);
  });

  it("writes nothing to the vault", async () => {
    // The pane is read-only. `ask` writes a note; inspection is the same
    // retrieval with none of the consequences.
    const { fs, provider } = await compiled();
    fs.resetCounters();

    await core(fs, provider).inspect("What ranks pages?");

    expect(fs.writes).toBe(0);
    expect(fs.moves).toBe(0);
    expect(fs.deletes).toBe(0);
  });
});

describe("invariant 2: the pane is never blocked by the lock", () => {
  it("answers while a compile holds the lock", async () => {
    const { fs } = await compiled();

    // A provider that parks the compile's first call until we let it go, so the
    // lock is provably held while inspect runs.
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parkedOnce = false;
    const stalling = new StubProvider(async (request: CompletionRequest) => {
      if (request.task === "inventory" && !parkedOnce) {
        parkedOnce = true;
        await parked;
      }
      return replyFor(request);
    });

    const held = core(fs, stalling);
    await fs.write("raw/second.md", "Another source about ranking.\n");
    const compiling = held.compile();
    // Let the compile reach its first model call and park there.
    while (held.busyWith === null) await new Promise((r) => setTimeout(r, 0));
    expect(held.busyWith).toBe("compile");

    const result = await held.inspect("What ranks pages?");

    expect(held.busyWith).toBe("compile");
    expect(result.ranked.length).toBeGreaterThan(0);
    release();
    await compiling;
  });
});

describe("the retrieval steps, as retrieval runs them", () => {
  it("force-includes a page the question names, even when the model returns none", async () => {
    // Force-inclusion is additive to the model's choices, and this proves it is the
    // force-include rule doing the work rather than the reply.
    const fs = new MemFs({ "raw/note.md": "PageRank matters for ranking.\n" });
    const provider = new StubProvider((request: CompletionRequest) =>
      request.task === "seed-selection" ? { seeds: [], keywords: [] } : replyFor(request),
    );
    await core(fs, provider).compile();

    const result = await core(fs, provider).inspect("Tell me about PageRank.");

    expect(result.seeds).toContain("wiki/concepts/PageRank.md");
  });

  it("reports the mode the predicate gives for the graph it ranked against", async () => {
    const { fs, provider } = await compiled();
    const instance = core(fs, provider);
    const graph = await instance.getGraph();

    const result = await instance.inspect("What ranks pages?");

    // Read from the predicate, not hardcoded: this vault is small, so it is
    // Mode A, and the assertion still holds if the fixture grows.
    expect(result.mode).toBe(modeOf(graph, normalizeSettings(DEFAULT_SETTINGS)));
  });

  it("ranks wiki pages only in Mode A", async () => {
    // "Mode A: wiki pages only". A raw node appearing here would
    // mean the graph ranker ran under the lexical mode's banner.
    const { fs, provider } = await compiled();
    const instance = core(fs, provider);
    expect(await instance.getGraph().then((g) => modeOf(g, normalizeSettings(DEFAULT_SETTINGS)))).toBe(
      "A",
    );

    const result = await instance.inspect("What ranks pages?");

    for (const node of result.ranked) expect(node.path.startsWith("wiki/")).toBe(true);
  });

  it("returns the keywords the seed call chose, which Mode A ranks with", async () => {
    const { fs, provider } = await compiled();

    const result = await core(fs, provider).inspect("What ranks pages?");

    expect(result.keywords).toEqual(["ranking"]);
  });
});

describe("the overlay is over the snapshot the pane is drawing", () => {
  /** A page written straight to disk, so the cached graph cannot know it. */
  const GHOST = "wiki/concepts/Ghost.md";
  const ghostPage =
    "---\nkind: concept\nsummary: ''\nupdated: '2026-08-20'\n---\nGhost prose about ranking.\n";

  it("ranks the cached snapshot, not a graph rebuilt for the occasion", async () => {
    // The decision this pins: `inspect` takes the snapshot it is handed. If it
    // rebuilt instead, the ghost would rank and the pane would light a node
    // that is not on screen.
    const { fs, provider } = await compiled();
    const instance = core(fs, provider);
    await instance.getGraph();
    await fs.write(GHOST, ghostPage);

    const result = await instance.inspect("What ranks pages?");

    expect(result.ranked.map((node) => node.path)).not.toContain(GHOST);
  });

  it("drops a model seed that is not on the snapshot rather than ranking nothing", async () => {
    // Mode B hands seeds to `computePPR`, which silently ignores any it cannot
    // find — so an off-snapshot seed used to produce an empty overlay with no
    // signal. Narrowing the seeds keeps the result honest about what it used.
    const { fs } = await compiled();
    const ghostSeeker = new StubProvider((request: CompletionRequest) =>
      request.task === "seed-selection"
        ? { seeds: [GHOST, "wiki/concepts/PageRank.md"], keywords: ["ranking"] }
        : replyFor(request),
    );
    const instance = core(fs, ghostSeeker);
    // Cache the snapshot first; only then does the ghost appear on disk, which
    // is the state the pane is in whenever a compile lands elsewhere.
    await instance.getGraph();
    await fs.write(GHOST, ghostPage);

    const result = await instance.inspect("What ranks pages?");

    expect(result.seeds).not.toContain(GHOST);
    expect(result.seeds).toContain("wiki/concepts/PageRank.md");
    expect(result.ranked.length).toBeGreaterThan(0);
  });

  it("reports Mode A for a vault below the predicate", async () => {
    // Read as a literal rather than from `modeOf`: an expectation derived from
    // the function under test agrees with it however wrong it becomes. The
    // fixture is a two-page vault, which is far below "≥ 20 nodes".
    const { fs, provider } = await compiled();

    const result = await core(fs, provider).inspect("What ranks pages?");

    expect(result.mode).toBe("A");
  });
});

describe("a rebuild racing a compile does not hand back a stale graph", () => {
  it("gives a caller the newer snapshot when its own build was superseded", async () => {
    // The defect this pins: the pane calls `getGraph` outside the lock, so a
    // walk it started before a compile's writes was still in flight when the
    // compile finished. The compile adopted it, cached it, and broadcast it —
    // a snapshot missing every page that compile had just written. Fixing only
    // the cache left the other half: the pane's own await still resolved with
    // the stale snapshot and it assigned that over the fresh one.
    const fs = new MemFs({ "raw/note.md": "PageRank matters for ranking.\n" });
    const provider = new StubProvider(replyFor);
    const instance = core(fs, provider);
    await instance.compile();

    // Park the pane's rebuild *after* it has read the wiki and before it reads
    // the manifest, so the pages it is holding are genuinely the old ones.
    // Parking on the first read instead would just delay a walk that then sees
    // the new state — and an assertion against that passes however the code
    // behaves, which is the shape this milestone keeps producing.
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parkedOnce = false;
    const originalRead = fs.read.bind(fs);
    fs.read = async (path: string) => {
      if (!parkedOnce && path === MANIFEST) {
        parkedOnce = true;
        await parked;
      }
      return originalRead(path);
    };

    // Force a cold read so the pane's call actually walks.
    const cold = createCore({
      fs,
      http: new StubHttp({}),
      manifestPath: MANIFEST,
      settings: { ...DEFAULT_SETTINGS, apiKey: "sk-ant-secret-key" },
      provider,
    });
    const paneRead = cold.getGraph();
    while (!parkedOnce) await new Promise((r) => setTimeout(r, 0));

    // A second source lands and compiles while that walk is parked.
    await fs.write("raw/second.md", "Eigenvector centrality ranks nodes.\n");
    await cold.compile();
    const afterCompile = await cold.getGraph();

    release();
    const paneGot = await paneRead;

    // The pane must not be handed something older than what is cached.
    expect(paneGot.nodes.length).toBe(afterCompile.nodes.length);
    expect(paneGot.nodes.map((node) => node.path)).toEqual(
      afterCompile.nodes.map((node) => node.path),
    );
  });
});

// The scrubber: "when an overlay was computed with snapshots, a slider scrubs
// per-iteration PPR vectors". The vectors have to come from the walk that
// produced the ranking — a second walk would agree here and would be free to
// stop agreeing later.
describe("the scrubber frames are the walk that ranked", () => {
  /** The demo vault is two nodes, so Mode B is reached through the predicate. */
  function modeB(fs: MemFs, provider: StubProvider) {
    return core(fs, provider, {
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: "sk-ant-secret-key",
        modeMinNodes: 0,
        modeMinLinkRatio: 0,
      },
    });
  }

  it("returns one vector per iteration, ending on the scores it ranked", async () => {
    const { fs, provider } = await compiled();

    const result = await modeB(fs, provider).inspect("What ranks pages?", { snapshots: true });

    expect(result.mode).toBe("B");
    expect(result.ranked.length).toBeGreaterThan(0);
    expect(result.iterations).toBeGreaterThanOrEqual(1);
    expect(result.snapshots).toHaveLength(result.iterations ?? -1);

    // The last retained vector is the ranking, node for node and value for
    // value — that is what makes the slider's rightmost stop the overlay the
    // user already sees.
    const last = result.snapshots?.[result.snapshots.length - 1];
    for (const node of result.ranked) {
      expect(last?.get(node.path)).toBe(node.score);
    }
    const positive = [...(last ?? new Map())].filter(([, score]) => score > 0).map(([path]) => path);
    expect(positive.sort()).toEqual(result.ranked.map((node) => node.path).sort());
  });

  it("retains nothing unless the caller asks", async () => {
    const { fs, provider } = await compiled();

    const result = await modeB(fs, provider).inspect("What ranks pages?");

    expect(result.mode).toBe("B");
    expect(result.snapshots).toBeUndefined();
    expect(result.iterations).toBeUndefined();
  });

  it("retains nothing in Mode A, which runs no walk", async () => {
    const { fs, provider } = await compiled();

    // The shipped predicate over a two-node vault: Mode A.
    const result = await core(fs, provider).inspect("What ranks pages?", { snapshots: true });

    expect(result.mode).toBe("A");
    expect(result.snapshots).toBeUndefined();
    expect(result.iterations).toBeUndefined();
  });

  it("still costs exactly one model call and writes nothing (invariant 12)", async () => {
    const { fs, provider } = await compiled();
    const before = provider.stats().byTask;
    fs.writes = 0;

    await modeB(fs, provider).inspect("What ranks pages?", { snapshots: true });

    const after = provider.stats().byTask;
    expect((after["seed-selection"] ?? 0) - (before["seed-selection"] ?? 0)).toBe(1);
    expect(after["synthesis"] ?? 0).toBe(before["synthesis"] ?? 0);
    expect(after["inventory"] ?? 0).toBe(before["inventory"] ?? 0);
    expect(after["page-generation"] ?? 0).toBe(before["page-generation"] ?? 0);
    expect(after["vision"] ?? 0).toBe(before["vision"] ?? 0);
    expect(fs.writes).toBe(0);
  });
});
