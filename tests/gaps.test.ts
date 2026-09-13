// Link resolution, shared by the health check and the answer note's
// `## Add next` section.
//
// One question — which of a page's wikilink targets resolve to nothing — asked
// by two consumers. The property that matters most is the last describe here:
// if the two ever stop agreeing, the wiki has two answers and one is wrong.
import { describe, expect, it } from "vitest";
import { scanPages, unresolvedTargets } from "../src/core/gaps";
import { buildGraph } from "../src/core/graph/build";
import { healthCheck, HEALTH_PATH } from "../src/core/health";
import { loadPageTable } from "../src/core/compile/pagetable";
import { MemFs } from "./helpers/memfs";

const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";

function page(kind: string, body: string, extra = ""): string {
  return `---\nkind: ${kind}\n${extra}summary: ''\nupdated: '2026-08-20'\n---\n${body}\n`;
}

/** Resolution over a whole vault, the way both consumers reach it. */
async function targetsOf(fs: MemFs) {
  const pages = await loadPageTable(fs);
  const { scans } = await scanPages(fs, pages);
  return unresolvedTargets(pages, scans);
}

describe("what counts as a target that resolves to nothing", () => {
  it("merges case variants under one target, spelled the way a page would be", async () => {
    // The namespace folds case, so `[[Zeppelin]]` and `[[zeppelin]]` name one
    // page — and therefore one gap wanted by two, not two wanted by one each.
    // The spelling shown is the `comparePaths`-minimum, so it does not depend
    // on which page the scan reached first.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "Wants [[zeppelin]]."),
      "wiki/concepts/B.md": page("concept", "Wants [[Zeppelin]]."),
      [MANIFEST]: "{}",
    });

    const targets = await targetsOf(fs);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.display).toBe("Zeppelin");
    expect(targets[0]?.handle).toBe("zeppelin");
    expect(targets[0]?.citers.map((c) => c.path)).toEqual([
      "wiki/concepts/A.md",
      "wiki/concepts/B.md",
    ]);
  });

  it("counts a page once however many times it reaches for the same name", async () => {
    // Demand is how many pages want it, not how often it is mentioned; a page
    // that names it three times is still one page that wants it.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "Wants [[Zeppelin]], [[Zeppelin|it]], [[Zeppelin]]."),
      [MANIFEST]: "{}",
    });

    const targets = await targetsOf(fs);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.citers).toHaveLength(1);
  });

  it("skips source links, heading references and block references", async () => {
    // Links into sources are full-path and are not title-resolved, and a
    // heading or block reference addresses a place inside a page rather than a
    // page. None of the three is a missing article.
    const fs = new MemFs({
      "wiki/concepts/A.md": page(
        "concept",
        "See [[raw/note.md]], [[Elsewhere#Section]] and [[Elsewhere^block]].",
      ),
      [MANIFEST]: "{}",
    });

    expect(await targetsOf(fs)).toEqual([]);
  });

  it("does not call a target a gap when an alias already answers to it", async () => {
    // Resolution runs through the title *and alias* table, so a page reachable
    // under another name is not missing.
    const fs = new MemFs({
      "wiki/concepts/PageRank.md": page("concept", "Body.", "aliases:\n  - PPR\n"),
      "wiki/concepts/A.md": page("concept", "Wants [[PPR]]."),
      [MANIFEST]: "{}",
    });

    expect(await targetsOf(fs)).toEqual([]);
  });

  it("gives the same answer for a vault scanned in the opposite order", async () => {
    // Determinism, on the two orderings that could leak scan order into the
    // result: which spelling is shown, and how the citers are listed.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "Wants [[zeppelin]] and [[Aardvark]]."),
      "wiki/concepts/B.md": page("concept", "Wants [[Zeppelin]]."),
      "wiki/concepts/C.md": page("concept", "Wants [[Zeppelin]]."),
      [MANIFEST]: "{}",
    });
    const pages = await loadPageTable(fs);
    const { scans } = await scanPages(fs, pages);

    const forward = unresolvedTargets(pages, scans);
    const reversed = unresolvedTargets([...pages].reverse(), [...scans].reverse());

    expect(reversed).toEqual(forward);
    // Most wanted first, so the order is the answer rather than an accident.
    expect(forward.map((t) => t.display)).toEqual(["Zeppelin", "Aardvark"]);
  });
});

describe("scanPages", () => {
  it("counts a page it could not read rather than failing the whole scan", async () => {
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

describe("the health report and the answer's section cannot disagree about what resolves", () => {
  it("lists the same unresolved targets the health check does", async () => {
    // The two consume one function. If they ever stop agreeing, the wiki has
    // two answers to "does this link resolve" and one of them is wrong.
    //
    // The case-variant page is what makes this test able to fail: the private
    // implementation this replaced grouped by the raw target string, so it
    // wrote `zeppelin` and `Zeppelin` as two candidates wanted by one each.
    // Without a variant in the fixture, both implementations agree.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "Wants [[Zeppelin]] and [[Aardvark]]."),
      "wiki/concepts/B.md": page("concept", "Wants [[Zeppelin]]."),
      "wiki/concepts/C.md": page("concept", "Wants [[_index]] and [[raw/note.md]]."),
      "wiki/concepts/D.md": page("concept", "Wants [[zeppelin]]."),
      [MANIFEST]: "{}",
    });
    await healthCheck({ fs, manifestPath: MANIFEST, now: () => new Date("2026-08-20T10:00:00Z") });
    const written = fs.text(HEALTH_PATH);

    const shared = await targetsOf(fs);

    for (const target of shared) {
      const from = [...new Set(target.citers.map((entry) => entry.title))].sort();
      expect(written).toContain(
        `- **${target.display}** — wanted by ${String(from.length)}: ${from.join(", ")}`,
      );
    }
    expect(written).toContain("- **Zeppelin** — wanted by 3: A, B, D");
    // And nothing beyond them: every candidate line the report carries is one
    // of these. `_index` is a candidate for the report, which lists everything.
    const lines = written.split("\n").filter((line) => line.startsWith("- **"));
    expect(lines).toHaveLength(shared.length);
    expect(shared.map((target) => target.display)).toContain("_index");
  });
});

describe("the graph the answer draws against", () => {
  it("holds no node for a target that resolves to nothing", async () => {
    // The graph drops a link that resolves to nothing, so a name the section
    // recommends can never have become a node. The section's diagram draws
    // those as ghosts precisely because the graph does not carry them.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "Wants [[Zeppelin]]."),
      "wiki/concepts/B.md": page("concept", "Wants [[Zeppelin]]."),
      [MANIFEST]: "{}",
    });

    const graph = await buildGraph({ fs, manifestPath: MANIFEST });

    expect((await targetsOf(fs)).map((t) => t.display)).toEqual(["Zeppelin"]);
    expect(graph.nodes.map((node) => node.path)).not.toContain("Zeppelin");
    expect(graph.edges).toEqual([]);
  });
});
