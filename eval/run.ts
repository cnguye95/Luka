// The eval harness (handoff.md §13).
//
// "eval/run.ts — headless over core with node adapters: CI mode seeds by exact
// title/alias match only (no model), runs both modes' ranking, reports
// recall@5, recall@10, MRR per query and mean; exits nonzero below a floor
// recorded in the YAML. `--live` flag: full pipeline with a real key, prints
// the same metrics; never in CI."
//
// It ranks through the product's own `rankModeA`/`rankModeB`, not a copy of
// them. An eval that reimplements the thing it measures reports on the copy.
//
// Run with `npm run eval` (CI mode) or `npm run eval:live`.
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { load } from "js-yaml";
import { buildGraph } from "../src/core/graph/build";
import { loadPageTable } from "../src/core/compile/pagetable";
import { renderIndex } from "../src/core/compile/indexdoc";
import { createProvider } from "../src/core/provider/wrapper";
import {
  forceIncludeSeeds,
  modeOf,
  rankModeA,
  rankModeB,
  selectSeeds,
} from "../src/core/retrieve/pipeline";
import { DEFAULT_SETTINGS, normalizeSettings, type RetrievalMode } from "../src/core/types";
import { NodeFs } from "./nodefs";
import { NodeHttp } from "./nodehttp";
import { belowFloor, summarize, type Floor, type QueryOutcome } from "./metrics";

const VAULT = path.resolve(process.cwd(), "eval", "fixture-vault");
const QUERIES = path.resolve(process.cwd(), "eval", "queries.yaml");
const MANIFEST = "ingest-manifest.json";

interface QuerySpec {
  query: string;
  expect: string[];
}

interface QueryFile {
  floors: Record<string, Floor>;
  queries: QuerySpec[];
}

async function readQueries(): Promise<QueryFile> {
  const parsed = load(await readFile(QUERIES, "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object") throw new Error("queries.yaml is not a mapping");
  const file = parsed as Partial<QueryFile>;
  if (!Array.isArray(file.queries) || file.queries.length === 0) {
    throw new Error("queries.yaml has no queries");
  }
  if (file.floors === undefined) throw new Error("queries.yaml records no floors");
  return { floors: file.floors, queries: file.queries };
}

/**
 * §13's CI seeding: "seeds by exact title/alias match only (no model)".
 *
 * That is `forceIncludeSeeds` — the rule §7.4 step 2 already applies to every
 * query — so CI measures the same seeding the product does, minus the model.
 * Keywords come from the query's own words, which is the most a harness can
 * know without asking one.
 */
function seedWithoutModel(question: string, pages: Parameters<typeof forceIncludeSeeds>[1]) {
  return {
    seeds: forceIncludeSeeds(question, pages),
    keywords: question.split(/\s+/).filter((word) => word.length > 2),
  };
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  const { floors, queries } = await readQueries();
  const fs = new NodeFs(VAULT);

  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    // §13's `--live` is the only mode that calls a model, and the key comes
    // from the environment — never from a file in the repo (invariant 9).
    apiKey: process.env["ANTHROPIC_API_KEY"] ?? "",
  });

  if (live && settings.apiKey === "") {
    console.error("--live needs ANTHROPIC_API_KEY in the environment.");
    process.exit(2);
  }

  const pages = await loadPageTable(fs);
  const graph = await buildGraph({ fs, manifestPath: MANIFEST });
  const indexText = renderIndex(pages);
  const provider = live ? createProvider({ http: new NodeHttp(), settings }) : null;

  console.log(
    `eval: ${String(pages.length)} pages, ${String(graph.nodes.length)} nodes, ` +
      `${String(graph.edges.length)} edges, ${String(queries.length)} queries` +
      `${live ? " (live)" : ""}`,
  );

  // §13: "runs both modes' ranking". Mode B is what the fixture's density
  // selects; Mode A is run alongside it so a change that only harms the small
  // -vault path cannot hide behind the graph one.
  const measured = modeOf(graph, settings);
  let failed = false;

  for (const mode of ["A", "B"] as RetrievalMode[]) {
    const outcomes: QueryOutcome[] = [];

    for (const spec of queries) {
      const chosen =
        provider === null
          ? seedWithoutModel(spec.query, pages)
          : await selectSeeds(provider, spec.query, indexText, pages, {
              seeds: settings.seedsCap,
              keywords: settings.keywordsCap,
            });
      const seeds = [...new Set([...chosen.seeds, ...forceIncludeSeeds(spec.query, pages)])];

      const ranked =
        mode === "B"
          ? rankModeB(graph, seeds, settings)
          : await rankModeA(fs, pages, seeds, chosen.keywords);

      outcomes.push({
        query: spec.query,
        ranked: ranked.map((node) => node.path),
        expected: spec.expect,
      });
    }

    const summary = summarize(outcomes);
    const floor = floors[mode];
    console.log(`\nMode ${mode}${mode === measured ? "  (the mode this vault selects)" : ""}`);
    for (const entry of summary.perQuery) {
      console.log(
        `  ${entry.recallAt5.toFixed(2)}  ${entry.recallAt10.toFixed(2)}  ` +
          `${entry.reciprocalRank.toFixed(3)}   ${entry.query}`,
      );
    }
    console.log(
      `  mean: recall@5 ${summary.meanRecallAt5.toFixed(4)}, ` +
        `recall@10 ${summary.meanRecallAt10.toFixed(4)}, MRR ${summary.mrr.toFixed(4)}`,
    );

    if (floor === undefined) {
      console.error(`  no floor recorded for mode ${mode}`);
      failed = true;
      continue;
    }
    for (const under of belowFloor(summary, floor)) {
      console.error(
        `  BELOW FLOOR: ${under.metric} ${under.measured.toFixed(4)} < ${under.floor.toFixed(4)}`,
      );
      failed = true;
    }
  }

  if (failed) {
    console.error("\neval failed: a metric came in under the floor recorded in queries.yaml.");
    process.exit(1);
  }
  console.log("\neval ok.");
}

await main();
