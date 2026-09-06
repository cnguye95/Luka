// §7.4's retrieval pipeline, and §7.3's mode predicate.
//
// "1. Page table (wiki pages only) renders to the same text as `_index.md`.
//  2. Seed call (strict JSON) … Returned paths are validated against the page
//     table; invalid ones are dropped. Any wiki page whose full title or alias
//     appears case-insensitively as a substring of the question is
//     force-included as a seed.
//  3. Rank. Mode B: PPR over the full graph seeded on (2). Mode A: wiki pages
//     only; lexical score …
//  5. Zero seeds and zero lexical candidates → skip retrieval …"
import type { FsAdapter } from "../adapters";
import { decodeUtf8 } from "../hash";
import { comparePaths } from "../paths";
import { handleOf } from "../compile/pagetable";
import { parseFrontmatter } from "../yaml";
import { computePPR, type PPROptions } from "../graph/ppr";
import { lexicalScore } from "./lexical";
import type { LLMProvider } from "../provider/types";
import type { GraphSnapshot, LukaSettings, PageKind, PageMeta, RetrievalMode } from "../types";

const SYSTEM = [
  "You choose which wiki pages are worth reading to answer a question.",
  "Reply with JSON only, in this exact shape:",
  '{"seeds": ["wiki/concepts/Example.md"], "keywords": ["term", "other term"]}',
  "- seeds: vault paths copied exactly from the index you are given. Never invent one.",
  "- keywords: words and short phrases a reader would search the wiki for.",
  "- Choose the pages most likely to contain the answer, not every related page.",
  "- Return empty lists if the index holds nothing relevant.",
].join("\n");

export interface SeedSelection {
  seeds: string[];
  keywords: string[];
}

/**
 * §7.4 step 2. A path the model invented is dropped rather than failing the
 * query — the same treatment Call A gives a malformed inventory item, and for
 * the same reason: one bad entry should not cost the user the whole answer.
 */
export async function selectSeeds(
  provider: LLMProvider,
  question: string,
  indexText: string,
  pages: readonly PageMeta[],
  caps: { seeds: number; keywords: number },
): Promise<SeedSelection> {
  const reply = await provider.complete({
    task: "seed-selection",
    json: true,
    system: SYSTEM,
    user: `Question: ${question}\n\n${indexText}`,
  });

  if (reply === null || typeof reply !== "object" || Array.isArray(reply)) {
    throw new Error("seed reply was not a JSON object");
  }
  const record = reply as Record<string, unknown>;
  const known = new Set(pages.map((page) => page.path));

  const seeds: string[] = [];
  for (const candidate of toStrings(record["seeds"])) {
    if (!known.has(candidate) || seeds.includes(candidate)) continue;
    seeds.push(candidate);
    if (seeds.length === caps.seeds) break;
  }

  const keywords: string[] = [];
  for (const candidate of toStrings(record["keywords"])) {
    if (keywords.includes(candidate)) continue;
    keywords.push(candidate);
    if (keywords.length === caps.keywords) break;
  }

  return { seeds, keywords };
}

/**
 * §7.4 step 2's force-include: "Any wiki page whose full title or alias appears
 * case-insensitively as a substring of the question."
 *
 * Additive and uncapped. The caps in §17 bound what the *model* may return; a
 * page the question names outright is not a guess that needs rationing.
 */
export function forceIncludeSeeds(question: string, pages: readonly PageMeta[]): string[] {
  const asked = handleOf(question);
  const found: string[] = [];
  for (const page of pages) {
    const names = [page.title, ...page.aliases];
    const named = names.some((name) => {
      const handle = handleOf(name);
      return handle !== "" && asked.includes(handle);
    });
    if (named) found.push(page.path);
  }
  return found.sort(comparePaths);
}

/**
 * §7.3: "Mode B (graph) iff node count ≥ 20 AND (total distinct written link
 * pairs / node count) ≥ 1.5; else Mode A."
 *
 * `edges` is already deduplicated per pair by §7.1, so its length is the
 * "distinct written link pairs" the predicate asks for.
 */
export function modeOf(graph: GraphSnapshot, settings: LukaSettings): RetrievalMode {
  const nodes = graph.nodes.length;
  if (nodes < settings.modeMinNodes) return "A";
  return graph.edges.length / nodes >= settings.modeMinLinkRatio ? "B" : "A";
}

export interface RankedNode {
  path: string;
  title: string;
  kind: PageKind | "raw";
  score: number;
}

/** §7.2: "ties in ranking break lexicographically". */
function byScoreThenPath(a: RankedNode, b: RankedNode): number {
  return b.score - a.score || comparePaths(a.path, b.path);
}

/**
 * §7.2's two settings, as `computePPR` wants them.
 *
 * Shared so the three callers that rank a walk — Mode B, the pane's click-PPR,
 * and §9's query inspection — cannot drift apart on α or the iteration ceiling.
 */
export function pprOptions(settings: LukaSettings): PPROptions {
  return { alpha: settings.pprAlpha, maxIterations: settings.pprMaxIterations };
}

/**
 * §7.4 step 3's ranking, given a walk that has already run.
 *
 * Split from `rankModeB` so a caller that needs the walk itself — §9's
 * scrubber wants its per-iteration vectors — can rank the very walk it
 * retained rather than running a second one and hoping the two agree.
 */
export function rankByScores(
  graph: GraphSnapshot,
  scores: ReadonlyMap<string, number>,
): RankedNode[] {
  const ranked: RankedNode[] = [];
  for (const node of graph.nodes) {
    const score = scores.get(node.path) ?? 0;
    // A zero score is not a candidate: it is a node the walk never reached.
    if (score <= 0) continue;
    ranked.push({ path: node.path, title: node.title, kind: node.kind, score });
  }
  return ranked.sort(byScoreThenPath);
}

/**
 * §7.4 step 3, Mode B: PPR over the *full* graph — wiki pages and raw source
 * nodes alike, which is what lets step 4 assemble source content in this mode.
 */
export function rankModeB(
  graph: GraphSnapshot,
  seedPaths: readonly string[],
  settings: LukaSettings,
): RankedNode[] {
  return rankByScores(graph, computePPR(graph, seedPaths, pprOptions(settings)).scores);
}

/**
 * §7.4 step 3, Mode A: "wiki pages only". Seeds count as candidates even when
 * no keyword touches them — the model chose them from the index, which is a
 * judgement the lexical score cannot express.
 */
export async function rankModeA(
  fs: FsAdapter,
  pages: readonly PageMeta[],
  seedPaths: readonly string[],
  keywords: readonly string[],
): Promise<RankedNode[]> {
  const seeds = new Set(seedPaths);
  const ranked: RankedNode[] = [];

  for (const page of pages) {
    let body = "";
    try {
      body = parseFrontmatter(decodeUtf8(await fs.read(page.path))).body;
    } catch {
      // A page that cannot be read scores on its frontmatter alone. It is in
      // the page table, so it exists; failing the whole query over one
      // unreadable file would be a worse answer than a slightly worse ranking.
    }
    const score = lexicalScore(page, body, keywords);
    if (score <= 0 && !seeds.has(page.path)) continue;
    ranked.push({ path: page.path, title: page.title, kind: page.kind, score });
  }

  return ranked.sort(byScoreThenPath);
}

function toStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}
