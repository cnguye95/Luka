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
  /**
   * How many queries are expected to land in the ranking-only subset under CI
   * seeding. Recorded so that a break in the harness's own `seeded` wiring
   * fails loudly: if every query were marked unseeded the subset would quietly
   * become the whole set, the ranking floors would stop measuring anything
   * they were set from, and the run would still pass.
   */
  rankingQueries: number;
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
  if (typeof file.rankingQueries !== "number") {
    throw new Error("queries.yaml records no rankingQueries count");
  }
  return {
    floors: validateFloors(file.floors as unknown),
    rankingQueries: file.rankingQueries,
    queries: file.queries,
  };
}

/**
 * Checks every floor is a real number before any mode is measured.
 *
 * A floor that reads as `undefined` compares `measured < NaN`, which is false —
 * so a malformed entry switches its own check off rather than failing, which is
 * the one thing floors exist to prevent. Two guards were written for this and
 * both sat one level too shallow: the first checked that `ranking:` existed,
 * not that it held numbers; the second checked the numbers, not that `ranking:`
 * held anything at all — a bare `ranking:` key parses as `null` and threw a
 * TypeError mid-run instead of naming the file. Validating the whole shape once
 * here is one place to be right, rather than three guards in the reporting loop
 * that each have to remember the same thing. `belowFloor` keeps its own
 * `Number.isFinite` check as a backstop for callers that do not come through
 * this function.
 */
function validateFloors(raw: unknown): Record<string, Floor> {
  if (raw === null || typeof raw !== "object") throw new Error("queries.yaml: floors is not a mapping");
  const out: Record<string, Floor> = {};

  for (const [mode, entry] of Object.entries(raw as Record<string, unknown>)) {
    const at = (where: string, value: unknown): number => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`queries.yaml: floors.${mode}.${where} is not a number`);
      }
      return value;
    };
    if (entry === null || typeof entry !== "object") {
      throw new Error(`queries.yaml: floors.${mode} is not a mapping`);
    }
    const level = entry as Record<string, unknown>;
    const ranking = level["ranking"];
    if (ranking === null || typeof ranking !== "object") {
      throw new Error(`queries.yaml: floors.${mode}.ranking is not a mapping`);
    }
    const inner = ranking as Record<string, unknown>;
    out[mode] = {
      recallAt5: at("recallAt5", level["recallAt5"]),
      recallAt10: at("recallAt10", level["recallAt10"]),
      mrr: at("mrr", level["mrr"]),
      ranking: {
        recallAt5: at("ranking.recallAt5", inner["recallAt5"]),
        recallAt10: at("ranking.recallAt10", inner["recallAt10"]),
        mrr: at("ranking.mrr", inner["mrr"]),
      },
    };
  }
  return out;
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
  const { floors, rankingQueries, queries } = await readQueries();
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

      // A query whose expected pages are all seeds already had its answer
      // handed to the ranker by §7.4 step 2; it scores the same however the
      // ranker behaves. `metrics.ts` keeps those out of the `ranking*` means.
      const seeded = new Set(seeds);

      outcomes.push({
        query: spec.query,
        ranked: ranked.map((node) => node.path),
        expected: spec.expect,
        seeded: spec.expect.every((path) => seeded.has(path)),
      });
    }

    const summary = summarize(outcomes);
    const floor = floors[mode];
    console.log(`\nMode ${mode}${mode === measured ? "  (the mode this vault selects)" : ""}`);
    for (const entry of summary.perQuery) {
      console.log(
        `  ${entry.recallAt5.toFixed(2)}  ${entry.recallAt10.toFixed(2)}  ` +
          `${entry.reciprocalRank.toFixed(3)}  ${entry.seeded ? " " : "*"}  ${entry.query}`,
      );
    }
    console.log(
      `  mean: recall@5 ${summary.meanRecallAt5.toFixed(4)}, ` +
        `recall@10 ${summary.meanRecallAt10.toFixed(4)}, MRR ${summary.mrr.toFixed(4)}`,
    );
    console.log(
      `  ranking-only (${String(summary.rankingQueries)} of ${String(queries.length)} queries, ` +
        `marked *): recall@5 ${summary.rankingRecallAt5.toFixed(4)}, ` +
        `recall@10 ${summary.rankingRecallAt10.toFixed(4)}, ` +
        `MRR ${summary.rankingMrr.toFixed(4)}`,
    );

    // Only under CI seeding: `--live` lets the model add seeds, so the size of
    // the subset legitimately moves.
    if (!live && summary.rankingQueries !== rankingQueries) {
      console.error(
        `  ranking subset is ${String(summary.rankingQueries)} queries, ` +
          `queries.yaml records ${String(rankingQueries)}`,
      );
      failed = true;
    }

    // The count alone cannot see `metrics.ts` filtering the wrong way round —
    // this fixture splits 8/8, so both halves satisfy it. The membership can:
    // the ranking means must be a mean over exactly the queries whose expected
    // pages were *not* all seeds, and that list is known here independently.
    const shouldRank = outcomes.filter((outcome) => !outcome.seeded).map((o) => o.query);
    const ranked = [...summary.rankingQueryNames];
    if (ranked.length !== shouldRank.length || ranked.some((q, at) => q !== shouldRank[at])) {
      console.error(
        `  the ranking means average the wrong queries:\n` +
          `    averaged: ${ranked.join(" | ")}\n` +
          `    expected: ${shouldRank.join(" | ")}`,
      );
      failed = true;
    }

    if (floor === undefined) {
      console.error(`  no floor recorded for mode ${mode}`);
      failed = true;
      continue;
    }
    // No `floor.ranking` guard here: `validateFloors` has already refused a
    // file whose ranking floors are missing, null, or not numbers, and it
    // names the offending key instead of throwing mid-measurement.
    for (const under of belowFloor(summary, floor)) {
      // §13 says `--live` "prints the same metrics". It cannot be held to the
      // ranking floors: those were calibrated from the 8 queries CI seeding
      // leaves unseeded, and a live model seeds the easy ones out of the
      // subset, so what remains is the hardest few averaged against a floor set
      // from all 8. A better model would fail the eval. The overall floors are
      // over every query and stay in force.
      if (live && under.scope === "ranking") {
        console.log(`  (not floored under --live: ${under.metric} ${under.measured.toFixed(4)})`);
        continue;
      }
      if (!Number.isFinite(under.floor)) {
        console.error(`  NO FLOOR: ${under.metric} has no numeric floor in queries.yaml`);
        failed = true;
        continue;
      }
      console.error(
        `  BELOW FLOOR: ${under.metric} ${under.measured.toFixed(4)} < ${under.floor.toFixed(4)}`,
      );
      failed = true;
    }
  }

  if (failed) {
    console.error("\neval failed: the run did not match what queries.yaml records.");
    process.exit(1);
  }
  console.log("\neval ok.");
}

await main();
