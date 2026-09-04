// "What to add next" — the structural gap scan behind the pane.
//
// Two properties carry most of these: the ranking is deterministic (a card
// order that depends on scan order is a card order the user cannot trust), and
// the scan asks the model nothing and writes nothing. The rest pin the filters,
// each of which exists because the measured vaults produced the noise it
// removes.
import { describe, expect, it } from "vitest";
import { createCore, type CoreDeps } from "../src/core/index";
import { gapReport, scanPages, unresolvedTargets, wikiDegrees } from "../src/core/gaps";
import { buildGraph } from "../src/core/graph/build";
import { healthCheck, HEALTH_PATH } from "../src/core/health";
import { loadPageTable } from "../src/core/compile/pagetable";
import { DEFAULT_SETTINGS, type GraphSnapshot } from "../src/core/types";
import { StubHttp } from "./helpers/http";
import { MemFs } from "./helpers/memfs";
import { StubProvider, inventoryReply } from "./helpers/provider";

const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";

function page(kind: string, body: string, extra = ""): string {
  return `---\nkind: ${kind}\n${extra}summary: ''\nupdated: '2026-08-20'\n---\n${body}\n`;
}

const cited = (entries: string[]) =>
  `<!-- citations:start -->\n## Sources\n${entries.map((e) => `- [[${e}]]`).join("\n")}\n<!-- citations:end -->`;

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

/** The report over a vault, through the same steps the façade takes. */
async function report(fs: MemFs) {
  const pages = await loadPageTable(fs);
  const { scans, unreadable } = await scanPages(fs, pages);
  const graph = await buildGraph({ fs, manifestPath: MANIFEST });
  return gapReport(pages, scans, graph, unreadable);
}

const titles = (cards: { title: string }[]) => cards.map((card) => card.title);

describe("new-article cards", () => {
  it("merges case variants under one card, spelled the way a page would be", async () => {
    // §4's namespace folds case, so a wiki cannot hold both spellings — two
    // half-wanted candidates would be an artifact of the scan, not of the vault.
    // The lowercase spelling is seen first (A.md sorts before B.md), so a card
    // titled "Zeppelin" can only come from choosing the spelling deliberately
    // rather than from taking whichever the scan reached first.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "Wants [[zeppelin]]."),
      "wiki/concepts/B.md": page("concept", "Wants [[Zeppelin]]."),
      [MANIFEST]: "{}",
    });

    const cards = (await report(fs)).cards;

    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe("Zeppelin");
    expect(cards[0]?.demand).toBe(2);
  });

  it("needs two distinct pages to want it, not two mentions on one page", async () => {
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "Wants [[Zeppelin]] and again [[Zeppelin|it]]."),
      [MANIFEST]: "{}",
    });

    expect((await report(fs)).cards).toEqual([]);
  });

  it("skips source links, heading references and block references", async () => {
    // §4: links into sources are full-path and are not title-resolved, and a
    // heading or block reference addresses a place inside a page.
    const body = "See [[raw/note.md]], [[Elsewhere#Section]] and [[Elsewhere^block]].";
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", body),
      "wiki/concepts/B.md": page("concept", body),
      [MANIFEST]: "{}",
    });

    expect((await report(fs)).cards).toEqual([]);
  });

  it("skips a name no page could ever be given", async () => {
    // `...` sanitizes to "Untitled" and `a/b` loses its slash, so neither names
    // a page the user could create. `_index` is the same test doing invariant
    // 8's work: `sanitizeTitle` strips the reserved prefix, so the name that
    // reaches the vault is not the name the link asked for.
    const body = "See [[_index]], [[...]] and [[a/b]].";
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", body),
      "wiki/concepts/B.md": page("concept", body),
      [MANIFEST]: "{}",
    });

    expect((await report(fs)).cards).toEqual([]);
  });

  it("does not call a target a gap when an alias already answers to it", async () => {
    const fs = new MemFs({
      "wiki/concepts/PageRank.md": page("concept", "Body.", "aliases:\n  - PPR\n"),
      "wiki/concepts/A.md": page("concept", "Wants [[PPR]]."),
      "wiki/concepts/B.md": page("concept", "Wants [[PPR]]."),
      [MANIFEST]: "{}",
    });

    expect((await report(fs)).cards.filter((card) => card.kind === "article")).toEqual([]);
  });

  it("ranks by demand times the wiki centrality of the pages that want it", async () => {
    // Two hubs wanting something is a stronger case than two leaves wanting it,
    // and that is the whole ranking claim: "wanted by pages that matter".
    const fs = new MemFs({
      "wiki/concepts/Hub1.md": page("concept", "Links [[Hub2]]. Wants [[Wanted]]."),
      "wiki/concepts/Hub2.md": page("concept", "Links [[Hub1]]. Wants [[Wanted]]."),
      "wiki/concepts/Leaf1.md": page("concept", "Wants [[Ignored]]."),
      "wiki/concepts/Leaf2.md": page("concept", "Wants [[Ignored]]."),
      [MANIFEST]: "{}",
    });

    const cards = (await report(fs)).cards.filter((card) => card.kind === "article");

    expect(titles(cards)).toEqual(["Wanted", "Ignored"]);
    expect(cards[0]?.weight).toBe(2);
    expect(cards[1]?.weight).toBe(0);
  });

  it("counts a page the snapshot has not seen as demand, but not as centrality", async () => {
    // The snapshot can lag the page table — the pane scans fresh and ranks from
    // a cached graph. A page written since the last rebuild still wants the
    // target, and still belongs in the key, but has no centrality to lend.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "Links [[B]]. Wants [[Wanted]]."),
      "wiki/concepts/B.md": page("concept", "Links [[A]]. Wants [[Wanted]]."),
      [MANIFEST]: "{}",
    });
    const stale = await buildGraph({ fs, manifestPath: MANIFEST });
    await fs.write("wiki/concepts/C.md", page("concept", "Wants [[Wanted]]."));

    const pages = await loadPageTable(fs);
    const { scans } = await scanPages(fs, pages);
    const card = gapReport(pages, scans, stale, 0).cards[0];

    expect(card?.demand).toBe(3);
    expect(card?.weight).toBe(2);
    expect(card?.key).toContain("wiki/concepts/C.md");
  });

  it("sorts an identifier-shaped name after a plain one it outscores", async () => {
    // Call B invites the model to "link freely"; on the measured vaults that
    // produced `link_pairs` and `linkTargets` beside the real concepts. Sorted
    // after rather than dropped: the user decides, not the filter.
    const fs = new MemFs({
      "wiki/concepts/H1.md": page("concept", "Links [[H2]]. Wants [[link_pairs]]."),
      "wiki/concepts/H2.md": page("concept", "Links [[H1]]. Wants [[link_pairs]]."),
      "wiki/concepts/L1.md": page("concept", "Wants [[Zeppelin]]."),
      "wiki/concepts/L2.md": page("concept", "Wants [[Zeppelin]]."),
      [MANIFEST]: "{}",
    });

    const cards = (await report(fs)).cards.filter((card) => card.kind === "article");

    // link_pairs scores higher and still comes second.
    expect(titles(cards)).toEqual(["Zeppelin", "link_pairs"]);
    expect(cards[0]?.demoted).toBe(false);
    expect(cards[1]?.demoted).toBe(true);
  });

  it("demotes a camelCase name and one already inside an existing title", async () => {
    const fs = new MemFs({
      "wiki/concepts/Vault nodes.md": page("concept", "Body."),
      "wiki/concepts/A.md": page("concept", "Wants [[vault]] and [[linkTargets]]."),
      "wiki/concepts/B.md": page("concept", "Wants [[vault]] and [[linkTargets]]."),
      [MANIFEST]: "{}",
    });

    const cards = (await report(fs)).cards.filter((card) => card.kind === "article");

    expect(cards.map((card) => card.demoted)).toEqual([true, true]);
  });
});

describe("thin-evidence cards", () => {
  const thinVault = () =>
    new MemFs({
      // §4: a source page's block cites its own raw file, always exactly one.
      "wiki/sources/note.md": page("source", `Body.\n${cited(["raw/note.md"])}`),
      "wiki/concepts/One.md": page("concept", `Links [[Two]].\n${cited(["raw/note.md"])}`),
      "wiki/concepts/Two.md": page(
        "concept",
        `Links [[One]].\n${cited(["raw/note.md", "raw/other.md"])}`,
      ),
      "wiki/concepts/Three.md": page("concept", "No citations at all."),
      [MANIFEST]: "{}",
    });

  it("excludes source pages, which all rest on exactly one by construction", async () => {
    const cards = (await report(thinVault())).cards.filter((card) => card.kind === "thin");

    expect(titles(cards)).toEqual(["One"]);
  });

  it("names the one source the page rests on", async () => {
    const card = (await report(thinVault())).cards.find((entry) => entry.kind === "thin");

    expect(card?.citation).toBe("raw/note.md");
    // Titled the way §7.1 titles a raw node, so both panes name one file alike.
    expect(card?.citers).toEqual([{ path: "raw/note.md", title: "note.md" }]);
  });

  it("ranks by wiki centrality and keeps only the top five", async () => {
    // Most pages on a real vault cite exactly one source, so uncapped this is a
    // list of the whole wiki. Ranked and capped it is a recommendation.
    const files: Record<string, string> = { [MANIFEST]: "{}" };
    for (let at = 0; at < 7; at++) {
      // Page 0 links to every other, page 1 to all but one, and so on: a
      // deterministic descending degree.
      const links = Array.from({ length: 7 - at - 1 }, (_, other) => `[[P${String(at + other + 1)}]]`);
      files[`wiki/concepts/P${String(at)}.md`] = page(
        "concept",
        `${links.join(" ")}\n${cited(["raw/note.md"])}`,
      );
    }

    const cards = (await report(new MemFs(files))).cards.filter((card) => card.kind === "thin");

    expect(cards).toHaveLength(5);
    expect(titles(cards)).toEqual(["P0", "P1", "P2", "P3", "P4"]);
  });
});

describe("wiki-only degree", () => {
  it("ignores the edges a page's citation block makes to its sources", async () => {
    // `GraphNode.degree` counts those too, and on the measured vaults about
    // half of every degree was citation edges — so "carries N links" would be
    // a claim about how many files a page cites, not how central it is.
    const fs = new MemFs({
      "wiki/concepts/One.md": page("concept", `Links [[Two]].\n${cited(["raw/note.md"])}`),
      "wiki/concepts/Two.md": page("concept", "Links [[One]]."),
      "raw/note.md": "A source.\n",
      [MANIFEST]: JSON.stringify({ "raw/note.md": { hash: "a" } }),
    });
    const graph = await buildGraph({ fs, manifestPath: MANIFEST });

    const degrees = wikiDegrees(graph);

    expect(graph.nodes.find((node) => node.path === "wiki/concepts/One.md")?.degree).toBe(2);
    expect(degrees.get("wiki/concepts/One.md")).toBe(1);
    // A raw node is not a wiki page and holds no wiki degree at all.
    expect(degrees.has("raw/note.md")).toBe(false);
  });
});

describe("the report is a function of the vault, not of the walk", () => {
  const permutable = () =>
    new MemFs({
      "wiki/concepts/A.md": page("concept", `Links [[B]]. Wants [[Zeppelin]].\n${cited(["raw/n.md"])}`),
      "wiki/concepts/B.md": page("concept", `Links [[A]]. Wants [[Zeppelin]].\n${cited(["raw/n.md"])}`),
      "wiki/concepts/C.md": page("concept", `Wants [[Zeppelin]] and [[Aardvark]].\n${cited(["raw/n.md"])}`),
      "wiki/concepts/D.md": page("concept", `Wants [[Aardvark]].\n${cited(["raw/n.md"])}`),
      [MANIFEST]: "{}",
    });

  it("gives the same answer for a scan read in the opposite order", async () => {
    const fs = permutable();
    const pages = await loadPageTable(fs);
    const { scans } = await scanPages(fs, pages);
    const graph = await buildGraph({ fs, manifestPath: MANIFEST });

    const forward = gapReport(pages, scans, graph, 0);
    const backward = gapReport([...pages].reverse(), [...scans].reverse(), graph, 0);

    expect(backward).toEqual(forward);
  });

  it("changes a card's key when the pages wanting it change, and not otherwise", async () => {
    // This is the whole of dismissal expiry: the key is the evidence, so new
    // evidence is a new card and an old dismissal no longer covers it.
    const fs = permutable();
    const before = (await report(fs)).cards.find((card) => card.title === "Zeppelin");

    const again = (await report(fs)).cards.find((card) => card.title === "Zeppelin");
    expect(again?.key).toBe(before?.key);

    await fs.write("wiki/concepts/E.md", page("concept", "Wants [[Zeppelin]]."));
    const after = (await report(fs)).cards.find((card) => card.title === "Zeppelin");

    expect(after?.key).not.toBe(before?.key);
  });
});

describe("the façade's gaps() (§9's pane is never blocked by the lock)", () => {
  const compiled = async () => {
    const fs = new MemFs({ "raw/note.md": "PageRank matters for ranking.\n" });
    const provider = new StubProvider((request) =>
      request.task === "page-generation"
        ? "Prose about [[PageRank]] and [[Convergence]]."
        : inventoryReply("A note about ranking.", [{ title: "PageRank", kind: "concept" }]),
    );
    await core(fs, provider).compile();
    return { fs, provider };
  };

  it("asks the model nothing", async () => {
    const { fs, provider } = await compiled();
    const spent = provider.stats().requests;

    await core(fs, provider).gaps();

    expect(provider.stats().requests).toBe(spent);
  });

  it("writes nothing to the vault", async () => {
    const { fs, provider } = await compiled();
    fs.resetCounters();

    await core(fs, provider).gaps();

    expect(fs.writes).toBe(0);
    expect(fs.moves).toBe(0);
    expect(fs.deletes).toBe(0);
  });

  it("answers while a compile holds the lock", async () => {
    const { fs } = await compiled();
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parkedOnce = false;
    const stalling = new StubProvider(async (request) => {
      if (request.task === "inventory" && !parkedOnce) {
        parkedOnce = true;
        await parked;
      }
      return request.task === "page-generation"
        ? "Prose."
        : inventoryReply("A note.", [{ title: "PageRank", kind: "concept" }]);
    });

    const held = core(fs, stalling);
    await fs.write("raw/second.md", "Another source about ranking.\n");
    const compiling = held.compile();
    while (held.busyWith === null) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held.busyWith).toBe("compile");

    const result = await held.gaps();

    expect(held.busyWith).toBe("compile");
    expect(result.unreadable).toBe(0);
    release();
    await compiling;
  });

  it("counts a page it could not read rather than failing the whole report", async () => {
    // The scan runs outside the lock, so a compile deleting a doomed page
    // underneath it is expected. One unreadable page costs that page.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "Wants [[Zeppelin]]."),
      "wiki/concepts/B.md": page("concept", "Wants [[Zeppelin]]."),
      [MANIFEST]: "{}",
    });
    const pages = await loadPageTable(fs);
    const originalRead = fs.read.bind(fs);
    fs.read = async (path: string) => {
      if (path === "wiki/concepts/B.md") throw new Error("gone");
      return originalRead(path);
    };

    const { scans, unreadable } = await scanPages(fs, pages);

    expect(unreadable).toBe(1);
    expect(scans.map((scan) => scan.page.path)).toEqual(["wiki/concepts/A.md"]);
  });
});

describe("§10's report and the pane cannot disagree about what resolves", () => {
  it("lists the same unresolved targets the health check does", async () => {
    // The two consume one function now. If they ever stop agreeing, the wiki
    // has two answers to "does this link resolve" and one of them is wrong.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "Wants [[Zeppelin]] and [[Aardvark]]."),
      "wiki/concepts/B.md": page("concept", "Wants [[Zeppelin]]."),
      "wiki/concepts/C.md": page("concept", "Wants [[_index]] and [[raw/note.md]]."),
      [MANIFEST]: "{}",
    });
    await healthCheck({ fs, manifestPath: MANIFEST, now: () => new Date("2026-08-20T10:00:00Z") });
    const written = fs.text(HEALTH_PATH);

    const pages = await loadPageTable(fs);
    const { scans } = await scanPages(fs, pages);
    const shared = unresolvedTargets(pages, scans);

    for (const target of shared) {
      const from = [...new Set(target.citers.map((entry) => entry.title))].sort();
      expect(written).toContain(
        `- **${target.display}** — wanted by ${String(from.length)}: ${from.join(", ")}`,
      );
    }
    // And nothing beyond them: every candidate line the report carries is one
    // of these. `_index` is a candidate for §10 (it lists everything) even
    // though the pane filters it out.
    const lines = written.split("\n").filter((line) => line.startsWith("- **"));
    expect(lines).toHaveLength(shared.length);
    expect(shared.map((target) => target.display)).toContain("_index");
  });
});

describe("the snapshot the report ranks against", () => {
  it("holds no ghost node for a gap", async () => {
    // The brief's hard rule, and it needs no code: §7.1 drops a link that
    // resolves to nothing, so a recommended article cannot become a node.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "Wants [[Zeppelin]]."),
      "wiki/concepts/B.md": page("concept", "Wants [[Zeppelin]]."),
      [MANIFEST]: "{}",
    });

    const graph: GraphSnapshot = await buildGraph({ fs, manifestPath: MANIFEST });
    const cards = (await report(fs)).cards;

    expect(cards).toHaveLength(1);
    expect(graph.nodes.map((node) => node.path)).not.toContain("Zeppelin");
    expect(graph.edges).toEqual([]);
  });
});
