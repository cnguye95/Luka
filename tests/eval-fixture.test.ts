// The committed eval fixture vault (handoff.md §13), read-only.
//
// The vault is evidence, and evidence that drifts is worse than none: §13's
// floors in `queries.yaml` only mean something if the substrate under them is
// the one they were measured against. These assertions fail loudly when a
// rebuild changes the shape of the vault, before a floor silently absorbs it.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/core/graph/build";
import { loadPageTable } from "../src/core/compile/pagetable";
import { loadManifest } from "../src/core/manifest";
import { parseFrontmatter } from "../src/core/yaml";
import { decodeUtf8 } from "../src/core/hash";
import { NodeFs } from "../eval/nodefs";

// §13 and §7.3, from the spec rather than from the fixture they describe.
const SPEC_MIN_SOURCES = 20;
const SPEC_MIN_PAGES = 40;
const SPEC_MODE_B_NODES = 20;
const SPEC_MODE_B_RATIO = 1.5;

const VAULT = path.resolve(import.meta.dirname, "..", "eval", "fixture-vault");
const MANIFEST = "ingest-manifest.json";

const fs = () => new NodeFs(VAULT);

describe("the fixture is the vault §13 asks for", () => {
  it("carries its own manifest, naming sources that exist", async () => {
    // §13: "including its own `ingest-manifest.json` so graph construction
    // knows the source set" — without it there are no raw nodes at all.
    const manifest = await loadManifest(fs(), MANIFEST);
    const paths = Object.keys(manifest);

    expect(paths.length).toBeGreaterThanOrEqual(SPEC_MIN_SOURCES - 3);
    for (const source of paths) {
      expect(await fs().exists(source), source).toBe(true);
    }
  });

  it("holds enough wiki pages to rank meaningfully", async () => {
    const pages = await loadPageTable(fs());

    expect(pages.length).toBeGreaterThanOrEqual(SPEC_MIN_PAGES);
  });

  it("has a page table every entry of which parses", async () => {
    const pages = await loadPageTable(fs());

    for (const page of pages) {
      const parsed = parseFrontmatter(decodeUtf8(await fs().read(page.path)));
      expect(parsed.data["kind"], page.path).toBeTypeOf("string");
      expect(page.title, page.path).not.toBe("");
    }
  });
});

describe("the fixture reaches Mode B, with margin (§7.3)", () => {
  it("clears both halves of the predicate by enough to survive an edit", async () => {
    const graph = await buildGraph({ fs: fs(), manifestPath: MANIFEST });
    const ratio = graph.edges.length / graph.nodes.length;

    expect(graph.nodes.length).toBeGreaterThanOrEqual(SPEC_MODE_B_NODES);
    // Margin, not just passage. At exactly 1.5 any edit to the corpus flips
    // the harness into Mode A and the Mode B numbers stop measuring anything.
    expect(ratio).toBeGreaterThan(SPEC_MODE_B_RATIO + 0.1);
  });

  it("includes raw source nodes, not only wiki pages", async () => {
    // Mode B ranks the full graph, so a fixture of wiki pages alone would
    // leave half of what it is supposed to measure unexercised.
    const graph = await buildGraph({ fs: fs(), manifestPath: MANIFEST });

    expect(graph.nodes.some((node) => node.kind === "raw")).toBe(true);
    expect(graph.edges.some((edge) => edge.a.startsWith("raw/") || edge.b.startsWith("raw/"))).toBe(
      true,
    );
  });

  it("has hubs and leaves rather than a uniform mesh", async () => {
    // A graph where every node has the same degree makes PPR and lexical
    // ranking agree everywhere, which would hide exactly the differences the
    // eval exists to measure.
    const graph = await buildGraph({ fs: fs(), manifestPath: MANIFEST });
    const degrees = graph.nodes.map((node) => node.degree);

    expect(Math.max(...degrees)).toBeGreaterThanOrEqual(6);
    expect(Math.min(...degrees)).toBeLessThanOrEqual(2);
  });

  it("contains the near-miss title pair a ranker has to tell apart", async () => {
    const titles = (await loadPageTable(fs())).map((page) => page.title);

    expect(titles).toContain("Turing machine");
    expect(titles).toContain("Turing test");
  });
});
