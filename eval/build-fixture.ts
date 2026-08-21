// Builds `eval/fixture-vault/` (handoff.md §13).
//
// "a committed, pre-built small vault (~20 sources, ~40 wiki pages, realistic
// links; author it by hand or by one-time generation, then commit; no model
// calls at eval time), including its own `ingest-manifest.json` so graph
// construction knows the source set."
//
// The sources under `raw/` are hand-written. Everything else here is produced
// by running the *real* compile pipeline over them with a scripted provider and
// a frozen clock, so the manifest, the citation blocks and the index are
// structurally exactly what compile writes rather than an imitation of it. No
// model is called, at build time or at eval time, and re-running this is
// byte-identical — which is what lets the committed vault be regenerated
// without moving the floors in `queries.yaml`.
//
// Run with `npm run eval:fixture`.
import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createCore } from "../src/core/index";
import { DEFAULT_SETTINGS } from "../src/core/types";
import type { CompletionRequest } from "../src/core/provider/types";
import { StubProvider, inventoryReply } from "../tests/helpers/provider";
import { StubHttp } from "../tests/helpers/http";
import { NodeFs } from "./nodefs";

// Resolved from the working directory, not from `import.meta.dirname`: this
// file is bundled into `.eval-cache/` before it runs, so the module's own
// location is the cache rather than `eval/`. npm scripts run at the package
// root, which is the stable anchor.
const VAULT = path.resolve(process.cwd(), "eval", "fixture-vault");
const MANIFEST = "ingest-manifest.json";

/** Frozen, so `ingested` and `updated` do not change between rebuilds. */
const NOW = new Date("2026-03-01T09:00:00Z");

interface Item {
  title: string;
  kind: "entity" | "concept";
  aliases?: string[];
  summary: string;
}

const TURING: Item = { title: "Alan Turing", kind: "entity", summary: "Mathematician; defined computability." };
const CHURCH: Item = { title: "Alonzo Church", kind: "entity", summary: "Logician; devised the lambda calculus." };
const HOPPER: Item = {
  title: "Grace Hopper",
  kind: "entity",
  aliases: ["Hopper", "Rear Admiral Hopper"],
  summary: "Wrote the first compiler and shaped COBOL.",
};
const VON_NEUMANN: Item = { title: "John von Neumann", kind: "entity", summary: "Wrote the EDVAC report." };
const STORED_PROGRAM: Item = {
  title: "Stored-program computer",
  kind: "concept",
  aliases: ["stored program"],
  summary: "Program and data share one memory.",
};
const LAMBDA: Item = { title: "Lambda calculus", kind: "concept", summary: "Computation as function application." };
const TURING_MACHINE: Item = {
  title: "Turing machine",
  kind: "concept",
  aliases: ["Turing machines"],
  summary: "Tape, head and a table of rules.",
};
const COLOSSUS: Item = { title: "Colossus", kind: "entity", summary: "Programmable electronic codebreaking machine." };
const BLETCHLEY: Item = { title: "Bletchley Park", kind: "entity", summary: "British codebreaking establishment." };
const ENIAC: Item = {
  title: "ENIAC",
  kind: "entity",
  aliases: ["Electronic Numerical Integrator and Computer"],
  summary: "Decimal valve machine programmed by rewiring.",
};
const COMPILER: Item = { title: "Compiler", kind: "concept", summary: "Turns one notation into another." };
const EDVAC: Item = { title: "EDVAC", kind: "entity", summary: "The machine the 1945 report described." };

/** Which items each source's inventory reports. Keyed by a phrase in its text. */
const INVENTORIES: { match: string; summary: string; items: Item[] }[] = [
  {
    match: "infinite tape",
    summary: "Turing's 1936 abstract machine and the halting problem.",
    items: [
      TURING_MACHINE,
      TURING,
      { title: "Halting problem", kind: "concept", summary: "No machine decides whether every machine stops." },
    ],
  },
  {
    match: "imitation game",
    summary: "Turing's 1950 proposal for a conversational test.",
    items: [{ title: "Turing test", kind: "concept", summary: "A judge tries to tell human from machine." }, TURING],
  },
  {
    match: "everything is a function",
    summary: "Church's formalism and its descendants.",
    items: [LAMBDA, CHURCH],
  },
  {
    match: "effectively calculable",
    summary: "The equivalence of two models of computation.",
    items: [
      { title: "Church-Turing thesis", kind: "concept", aliases: ["Church-Turing"], summary: "Effective calculability equals Turing computability." },
      TURING,
      CHURCH,
      LAMBDA,
      TURING_MACHINE,
    ],
  },
  {
    match: "eighteen thousand vacuum tubes",
    summary: "The 1945 valve machine and the women who programmed it.",
    items: [
      ENIAC,
      { title: "Jean Bartik", kind: "entity", summary: "One of ENIAC's first programmers." },
      { title: "Vacuum tube", kind: "concept", aliases: ["valve"], summary: "The switching element before the transistor." },
    ],
  },
  {
    match: "same memory as the data",
    summary: "Why a machine can be reprogrammed by loading bytes.",
    items: [STORED_PROGRAM, EDVAC],
  },
  {
    match: "circulated with only his name",
    summary: "The 1945 draft that named an architecture.",
    items: [EDVAC, VON_NEUMANN, STORED_PROGRAM],
  },
  {
    match: "Lorenz cipher",
    summary: "The first programmable electronic digital computer.",
    items: [
      COLOSSUS,
      { title: "Tommy Flowers", kind: "entity", summary: "Designed Colossus." },
      BLETCHLEY,
      { title: "Lorenz cipher", kind: "concept", summary: "The German teleprinter cipher Colossus attacked." },
    ],
  },
  {
    match: "British codebreaking",
    summary: "Where Enigma and Lorenz were broken.",
    items: [BLETCHLEY, { title: "Enigma", kind: "concept", summary: "The German rotor cipher machine." }, COLOSSUS],
  },
  {
    match: "A-0 in 1952",
    summary: "Hopper's A-0 and the contested idea behind it.",
    items: [COMPILER, HOPPER],
  },
  {
    match: "Designed by committee",
    summary: "The verbose language still running payrolls.",
    items: [
      { title: "COBOL", kind: "entity", aliases: ["Common Business-Oriented Language"], summary: "Deliberately readable business language." },
      HOPPER,
    ],
  },
  {
    match: "introduced it for Lisp",
    summary: "McCarthy's bargain for Lisp.",
    items: [
      { title: "Garbage collection", kind: "concept", summary: "Reclaiming memory a program has finished with." },
      { title: "John McCarthy", kind: "entity", summary: "Introduced garbage collection for Lisp." },
      { title: "Lisp", kind: "entity", summary: "The language garbage collection was built for." },
    ],
  },
  {
    match: "base case",
    summary: "Notes on recursion and the Y combinator.",
    items: [{ title: "Recursion", kind: "concept", summary: "A definition that refers to itself." }, LAMBDA],
  },
  {
    match: "On Computable Numbers",
    summary: "A short reading list.",
    items: [TURING, CHURCH, VON_NEUMANN, HOPPER],
  },
  {
    match: "take until 1945",
    summary: "Two unresolved questions.",
    items: [STORED_PROGRAM, COLOSSUS],
  },
  {
    match: "rear admiral",
    summary: "A biography of Grace Hopper.",
    items: [HOPPER, COMPILER, { title: "COBOL", kind: "entity", summary: "Deliberately readable business language." }],
  },
  {
    match: "single path between processor",
    summary: "The architecture and its bottleneck.",
    items: [
      { title: "Von Neumann architecture", kind: "concept", summary: "Processor, control, shared memory, I/O." },
      VON_NEUMANN,
      { title: "Von Neumann bottleneck", kind: "concept", summary: "One path between processor and memory." },
    ],
  },
  {
    match: "Manchester Baby",
    summary: "A table of early machines.",
    items: [
      ENIAC,
      COLOSSUS,
      { title: "EDSAC", kind: "entity", summary: "Cambridge stored-program machine, 1949." },
      { title: "Manchester Baby", kind: "entity", summary: "First stored-program machine to run, 1948." },
    ],
  },
];

/**
 * What each page's prose links to. This is the graph's real structure: two
 * hubs, chains that make a two-hop question meaningful, and a near-miss title
 * pair ("Turing machine" / "Turing test") that a ranker has to tell apart.
 */
const LINKS: Record<string, string[]> = {
  "Turing machine": ["Alan Turing", "Halting problem", "Church-Turing thesis"],
  "Turing test": ["Alan Turing", "Turing machine"],
  "Alan Turing": ["Turing machine", "Bletchley Park", "Church-Turing thesis"],
  "Halting problem": ["Turing machine", "Church-Turing thesis"],
  "Lambda calculus": ["Alonzo Church", "Church-Turing thesis", "Recursion"],
  "Alonzo Church": ["Lambda calculus", "Recursion"],
  "Church-Turing thesis": ["Turing machine", "Lambda calculus", "Alan Turing", "Alonzo Church"],
  ENIAC: ["Jean Bartik", "Vacuum tube", "Stored-program computer"],
  "Jean Bartik": ["ENIAC", "Stored-program computer"],
  "Vacuum tube": ["ENIAC", "Colossus", "EDSAC", "Manchester Baby"],
  "Stored-program computer": ["EDVAC", "Von Neumann architecture", "ENIAC", "Manchester Baby"],
  EDVAC: ["John von Neumann", "Stored-program computer", "EDSAC", "Manchester Baby"],
  "John von Neumann": ["EDVAC", "Von Neumann architecture"],
  Colossus: ["Bletchley Park", "Tommy Flowers", "Lorenz cipher", "Vacuum tube"],
  "Tommy Flowers": ["Colossus", "Vacuum tube"],
  "Bletchley Park": ["Colossus", "Enigma", "Alan Turing"],
  "Lorenz cipher": ["Colossus", "Bletchley Park"],
  Enigma: ["Bletchley Park", "Alan Turing"],
  Compiler: ["Grace Hopper", "COBOL", "Lisp"],
  "Grace Hopper": ["Compiler", "COBOL", "Stored-program computer"],
  COBOL: ["Grace Hopper", "Compiler"],
  "Garbage collection": ["Lisp", "John McCarthy", "Recursion"],
  "John McCarthy": ["Lisp", "Garbage collection"],
  Lisp: ["Garbage collection", "Lambda calculus", "Recursion"],
  Recursion: ["Lambda calculus"],
  "Von Neumann architecture": ["John von Neumann", "Stored-program computer", "Von Neumann bottleneck"],
  "Von Neumann bottleneck": ["Von Neumann architecture", "Stored-program computer"],
  EDSAC: ["Stored-program computer"],
  "Manchester Baby": ["Stored-program computer", "EDSAC"],
};

/** Sources whose inventory phrase matched nothing; a build with any fails. */
const unmatched: string[] = [];

function replyFor(request: CompletionRequest): unknown {
  if (request.task === "page-generation") {
    const title = /Title: (.+)/.exec(request.user)?.[1]?.trim() ?? "Untitled";
    const links = (LINKS[title] ?? []).map((target) => `[[${target}]]`).join(", ");
    const tail = links === "" ? "It stands on its own here." : `It connects to ${links}.`;
    return `${title} is one of the threads this vault follows. ${tail}`;
  }
  if (request.task === "vision") return "An unrelated image.";

  const found = INVENTORIES.find((entry) => request.user.includes(entry.match));
  if (found === undefined) {
    // Loudly, not quietly. A phrase that stopped matching — because the source
    // was reworded, or because it wraps across a line the way `allocate
    // without having` did — would otherwise yield a source with no items, and
    // the fixture would shrink by a few pages without anyone noticing until a
    // floor absorbed it.
    unmatched.push(request.user.split("\n")[0] ?? "(empty)");
    return inventoryReply("An unremarkable source.", []);
  }
  return inventoryReply(
    found.summary,
    found.items.map((item) => ({
      title: item.title,
      kind: item.kind,
      aliases: item.aliases ?? [],
      summary: item.summary,
    })),
  );
}

async function main(): Promise<void> {
  const fs = new NodeFs(VAULT);

  // Wipe everything compile owns, so a rebuild cannot inherit stale state and
  // quietly diverge from what a fresh run would produce.
  await rm(path.join(VAULT, "wiki"), { recursive: true, force: true });
  await rm(path.join(VAULT, MANIFEST), { force: true });

  const core = createCore({
    fs,
    http: new StubHttp({}),
    // §13 wants the manifest committed with the vault, so it sits at the root
    // rather than in a plugin folder that is not part of the fixture.
    manifestPath: MANIFEST,
    settings: { ...DEFAULT_SETTINGS, apiKey: "fixture" },
    now: () => NOW,
    provider: new StubProvider(replyFor),
  });

  const result = await core.compile();
  if (result.failed.length > 0) {
    console.error("fixture build failed:", result.failed);
    process.exit(1);
  }
  if (unmatched.length > 0) {
    console.error("fixture build failed: no inventory phrase matched these sources:");
    for (const line of unmatched) console.error(`  ${line}`);
    process.exit(1);
  }

  const graph = await core.getGraph();
  const ratio = graph.edges.length / graph.nodes.length;
  console.log(
    `fixture: ${String(result.added)} sources, ${String(result.pagesWritten)} pages, ` +
      `${String(graph.nodes.length)} nodes, ${String(graph.edges.length)} edges ` +
      `(ratio ${ratio.toFixed(2)})`,
  );
}

await main();
