// Randomised vault churn against the one property the rename/derivative design
// exists to guarantee: however badly a run goes, the vault converges once the
// trouble stops, and says the same thing about itself every time afterwards.
//
// Three churned compiles — sources added, deleted, renamed, edited, derivatives
// meddled with, user files dropped on derivative stems — with transient IO
// failures injected and page generation failing part of the time. Then the
// trouble stops, and the next three compiles must agree on every file, every
// manifest key and every failure, with the last two doing nothing at all.
//
// Two modes. Faults confined to `raw/` exercise the subsystem; faults anywhere
// also hit the unguarded index and manifest writes, which end the run outright
// — the crash window, where nothing was committed and the next run must redo
// the work.
//
// This found five real defects across two review rounds. The seed count is kept
// small enough to belong in the suite; CHURN_SEEDS raises it (1500 is what the
// review rounds ran, and takes about 45 seconds per mode).
import { describe, expect, it } from "vitest";
import { createCore, type CompileResult } from "../src/core/index";
import { DEFAULT_SETTINGS, type ManifestEntry } from "../src/core/types";
import { pngBytes } from "./helpers/images";
import { StubHttp } from "./helpers/http";
import { MemFs } from "./helpers/memfs";
import { StubProvider, fatalError, inventoryReply } from "./helpers/provider";

const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";
const SEEDS = Number(process.env.CHURN_SEEDS ?? 120);

/** Deterministic PRNG: every seed reproduces its own run exactly. */
function rng(seed: number): () => number {
  let a = seed + 0x6d2b79f5;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A vault whose writes, moves and deletes fail while `failRate` is non-zero. */
class FaultyFs extends MemFs {
  failRate = 0;
  /** `true` fails anywhere, including the index and manifest writes, which are
   *  unguarded in compile — so the run aborts mid-flight, which is the crash
   *  window worth testing. `false` confines faults to `raw/`, the subsystem
   *  under review. */
  everywhere = false;
  next: () => number = () => 1;

  private trip(path: string): boolean {
    if (!this.everywhere && !path.startsWith("raw/")) return false;
    return this.next() < this.failRate;
  }

  override async write(path: string, data: string | Uint8Array): Promise<void> {
    if (this.trip(path)) throw new Error(`EACCES ${path}`);
    return super.write(path, data);
  }
  override async move(from: string, to: string): Promise<void> {
    if (this.trip(from)) throw new Error(`EXDEV ${from}`);
    return super.move(from, to);
  }
  override async delete(path: string): Promise<void> {
    if (this.trip(path)) throw new Error(`EPERM ${path}`);
    return super.delete(path);
  }
}

const BODIES = [
  "Ranking matters here.\n",
  "Graphs and Ranking.\n",
  "Notes about Graphs.\n",
  "Nothing in particular.\n",
];

let failPages = 0;
let pagePick: () => number = () => 1;

function reply(request: { task: string; user: string }): unknown {
  if (request.task === "page-generation") {
    return pagePick() < failPages ? fatalError("generation is down") : "Body.\n";
  }
  if (request.task === "vision") return "An image.\n";
  const items: { title: string; kind: "concept" }[] = [];
  for (const title of ["Ranking", "Graphs", "Notes"]) {
    if (request.user.includes(title)) items.push({ title, kind: "concept" });
  }
  return inventoryReply("A source.", items);
}

function core(fs: MemFs) {
  return createCore({
    fs,
    http: new StubHttp({}),
    manifestPath: MANIFEST,
    settings: { ...DEFAULT_SETTINGS, apiKey: "test-key" },
    now: () => new Date("2026-08-19T10:00:00Z"),
    provider: new StubProvider(reply as never),
  }).compile();
}

const EXTENSIONS = [".md", ".txt", ".html", ".csv", ".tsv", ".png"];

function bodyFor(extension: string, pick: () => number): string | Uint8Array {
  if (extension === ".png") return pngBytes(8 + Math.floor(pick() * 8), 8);
  if (extension === ".csv") return "a,b\n1,2\n3,4\n";
  if (extension === ".tsv") return "a\tb\n1\t2\n";
  if (extension === ".html") return `<p>${BODIES[Math.floor(pick() * BODIES.length)]}</p>\n`;
  return BODIES[Math.floor(pick() * BODIES.length)] as string;
}

/** Source files only — never derivatives, and never the manifest. */
function sourcesOf(fs: MemFs): string[] {
  return fs
    .paths()
    .filter((path) => path.startsWith("raw/"))
    .filter((path) => !fs.text(path).includes("derived-from:"))
    .sort();
}

function derivativesOf(fs: MemFs): string[] {
  return fs
    .paths()
    .filter((path) => path.startsWith("raw/") && path.endsWith(".md"))
    .filter((path) => fs.text(path).includes("derived-from:"))
    .sort();
}

function manifestOf(fs: MemFs): Record<string, ManifestEntry> {
  try {
    return JSON.parse(fs.text(MANIFEST)) as Record<string, ManifestEntry>;
  } catch {
    return {};
  }
}

/** The whole observable state, as one comparable string. */
function snapshot(fs: MemFs, result: CompileResult): string {
  return JSON.stringify({
    files: fs.paths().sort(),
    manifestKeys: Object.keys(manifestOf(fs)).sort(),
    failed: result.failed.map((entry) => entry.path).sort(),
  });
}

async function churn(fs: MemFs, pick: () => number, round: number): Promise<void> {
  const operations = 1 + Math.floor(pick() * 5);
  for (let n = 0; n < operations; n += 1) {
    const sources = sourcesOf(fs);
    const derivatives = derivativesOf(fs);
    const roll = pick();

    if (roll < 0.28 || sources.length === 0) {
      // Add a source, sometimes onto a stem another source already claims.
      const extension = EXTENSIONS[Math.floor(pick() * EXTENSIONS.length)] as string;
      const stem = pick() < 0.4 ? "shared" : `s${round}${n}`;
      const folder = pick() < 0.3 ? "raw/sub" : "raw";
      await fs.write(`${folder}/${stem}${extension}`, bodyFor(extension, pick));
      continue;
    }

    const victim = sources[Math.floor(pick() * sources.length)] as string;

    if (roll < 0.40) {
      await fs.delete(victim);
    } else if (roll < 0.66) {
      // Rename: same bytes, new path. Sometimes changing the extension too.
      const bytes = fs.files.get(victim) as Uint8Array;
      const extension = pick() < 0.3 ? ".txt" : (victim.match(/\.[a-z]+$/)?.[0] ?? ".md");
      const folder = pick() < 0.5 ? "raw/moved" : "raw";
      const stem = pick() < 0.5 ? ["hold", "swap", "shared"][Math.floor(pick() * 3)] : `r${round}${n}`;
      const target = `${folder}/${stem}${extension}`;
      if (!(await fs.exists(target))) {
        fs.files.delete(victim);
        fs.files.set(target, bytes);
      }
    } else if (roll < 0.78) {
      // Edit in place.
      const extension = victim.match(/\.[a-z]+$/)?.[0] ?? ".md";
      await fs.write(victim, bodyFor(extension, pick));
    } else if (derivatives.length > 0 && roll < 0.9) {
      // Meddle with a derivative: repair it, adopt it, or remove it.
      const file = derivatives[Math.floor(pick() * derivatives.length)] as string;
      const how = pick();
      if (how < 0.4) await fs.write(file, `${fs.text(file)}\nHAND REPAIRED.\n`);
      else if (how < 0.7) await fs.delete(file);
      else await fs.write(file, fs.text(file).replace(/derived-from: .*/, "derived-from: raw/x.csv"));
    } else if (roll < 0.95) {
      // Drop a plain user file where a derivative would like to live.
      const stem = pick() < 0.5 ? "shared" : `s${round}0`;
      await fs.write(`raw/${stem}.md`, "My own note.\n");
    } else {
      // Markdown naming a source that exists nowhere: the shape a migration or
      // an abandoned carry leaves behind, which used to hold its stem for good.
      const stem = pick() < 0.5 ? "shared" : `s${round}${n}`;
      await fs.write(
        `raw/${stem}.md`,
        `---\ningested: '2026-08-19'\nsource-format: html\nderived-from: raw/ghost-${round}.html\n---\nAbandoned.\n`,
      );
    }
  }
}

async function sweep(everywhere: boolean): Promise<string[]> {
  const failures: string[] = [];
  let aborted = 0;

  const FIRST = Number(process.env.CHURN_FIRST ?? 0);
  for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
      const pick = rng(seed);
      const fs = new FaultyFs();
      fs.next = pick;
      fs.everywhere = everywhere;

      try {
        // Three churned rounds with transient IO failures.
        const rate = 0.04 + pick() * 0.12;
        pagePick = pick;
        for (let round = 0; round < 3; round += 1) {
          fs.failRate = 0;
          failPages = 0;
          await churn(fs, pick, round);
          fs.failRate = rate;
          failPages = pick() < 0.5 ? 0.25 : 0;
          // An unguarded write can abort the run outright. That is the crash
          // window: nothing was committed, so the next run must redo the work.
          try {
            await core(fs);
          } catch {
            aborted += 1;
          }
        }

        // Then the trouble stops. Nothing else changes the vault.
        fs.failRate = 0;
        failPages = 0;
        const settling = await core(fs);
        const after = [snapshot(fs, settling)];
        const results: CompileResult[] = [settling];
        for (let round = 0; round < 2; round += 1) {
          const result = await core(fs);
          results.push(result);
          after.push(snapshot(fs, result));
        }

        // The three clean compiles must agree on everything observable, and the
        // two after the settling one must do nothing at all.
        if (after[1] !== after[2]) {
          failures.push(`seed ${seed}: not stable\n  5: ${after[1]}\n  6: ${after[2]}`);
          continue;
        }
        // And the settling compile must actually settle: whatever it reported
        // about its own work, it must leave the vault where the quiet compiles
        // find it.
        const vault = (at: number): string => {
          const parsed = JSON.parse(after[at] as string) as Record<string, unknown>;
          return JSON.stringify([parsed["files"], parsed["manifestKeys"]]);
        };
        if (vault(0) !== vault(1)) {
          failures.push(`seed ${seed}: not settled after one clean compile\n  4: ${after[0]}\n  5: ${after[1]}`);
          continue;
        }
        if (!results[1]?.noop || !results[2]?.noop) {
          failures.push(
            `seed ${seed}: still working — noop 5=${results[1]?.noop} 6=${results[2]?.noop}`,
          );
          continue;
        }
        // Invariant 12: a settled vault asks the model nothing.
        if (results[1]?.modelCalls !== 0 || results[2]?.modelCalls !== 0) {
          failures.push(`seed ${seed}: model calls on a settled vault`);
          continue;
        }
        // Every manifest entry must name markdown that is actually there.
        for (const [path, entry] of Object.entries(manifestOf(fs))) {
          if (entry.hash === "cascade-pending") continue;
          const readable = entry.derivative ?? path;
          if (!(await fs.exists(readable))) {
            failures.push(`seed ${seed}: ${path} names missing markdown ${readable}`);
          }
        }
      } catch (error) {
        failures.push(`seed ${seed}: clean compile threw — ${String(error)}`);
      }
  }

  console.log(
    `  ${everywhere ? "faults everywhere" : "faults in raw/ only"}: ${SEEDS} seeds, ` +
      `${aborted} aborted runs, ${failures.length} failures`,
  );
  for (const entry of failures.slice(0, 10)) console.log(entry);
  return failures;
}

describe("randomised churn converges", { timeout: 900_000 }, () => {
  it(`settles after faults in raw/, over ${SEEDS} seeds`, async () => {
    expect(await sweep(false)).toEqual([]);
  });

  it(`settles after aborted runs, over ${SEEDS} seeds`, async () => {
    expect(await sweep(true)).toEqual([]);
  });
});
