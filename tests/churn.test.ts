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
import { sha256Hex } from "../src/core/hash";

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

const REPAIR_MARK = "HAND REPAIRED.";

/**
 * §6.2, checkable: "a derivative persists until the original changes", and
 * M2e's failure policy adds "or until a run says it could not keep it".
 *
 * Convergence alone cannot see a violation — a destroyed repair settles as
 * happily as a preserved one — and destroying a user's work silently is the
 * shape of the worst defect either review round found. So each repaired
 * derivative is pinned to the source that owns it, together with whether that
 * source was unchanged going into the compile. Only the unchanged ones are the
 * spec's business: an edited original is entitled to a fresh extraction.
 */
async function repairsBefore(fs: MemFs): Promise<Map<string, string>> {
  const pinned = new Map<string, string>();
  const manifest = manifestOf(fs);
  for (const path of derivativesOf(fs)) {
    const text = fs.text(path);
    if (!text.includes(REPAIR_MARK)) continue;
    const origin = /^derived-from: (.*)$/m.exec(text)?.[1]?.trim();
    if (origin === undefined) continue;
    const entry = manifest[origin];
    const bytes = fs.files.get(origin);
    if (entry?.derivative === undefined || bytes === undefined) continue;
    // Only the file the entry actually names. A stale copy elsewhere may carry
    // the same origin and the same marker, and it is not the source's markdown
    // — pinning it would report a loss against a file that never held one.
    if (entry.derivative !== path) continue;
    // Unchanged going in: the manifest's hash still describes the file. An
    // original that changed has no claim on its old derivative.
    if (entry.hash === (await sha256Hex(bytes))) pinned.set(origin, path);
  }
  return pinned;
}

/**
 * Every repaired derivative and the origin it names, whatever the manifest
 * thinks. Cheaper and broader than the pinned map: it does not care whether the
 * origin is on disk, which matters because the dangerous case is precisely an
 * origin that is *not* — a source that has been renamed away still owns its
 * markdown, and "the path it names does not resolve" is not evidence otherwise.
 */
function markedDerivatives(fs: MemFs): Map<string, string> {
  const marked = new Map<string, string>();
  for (const path of derivativesOf(fs)) {
    const text = fs.text(path);
    if (!text.includes(REPAIR_MARK)) continue;
    const origin = /^derived-from: (.*)$/m.exec(text)?.[1]?.trim();
    if (origin !== undefined) marked.set(path, origin);
  }
  return marked;
}

/**
 * Repaired markdown that was taken over by a different source without a word.
 *
 * Losing the marker is allowed — an edited original re-extracts, and policy B
 * re-extracts on a complication and reports it. What is never allowed is the
 * file being rewritten *for somebody else*: that is another source's markdown
 * being destroyed, which is what invariant 7 exists to prevent.
 */
function repairsStolen(
  fs: MemFs,
  marked: ReadonlyMap<string, string>,
  result: CompileResult,
): string[] {
  if (result.reported.length > 0) return [];
  const manifest = manifestOf(fs);
  const stolen: string[] = [];
  for (const [path, origin] of marked) {
    if (!fs.files.has(path)) continue;
    // The owner left the vault this run, so the sweep released its markdown and
    // the path is free for whoever wants it — that is the sweep-before-extract
    // ordering working, not a theft.
    if (!Object.hasOwn(manifest, origin)) continue;
    const text = fs.text(path);
    if (text.includes(REPAIR_MARK)) continue;
    const now = /^derived-from: (.*)$/m.exec(text)?.[1]?.trim();
    if (now !== undefined && now !== origin) stolen.push(`${path}: ${origin} -> ${now}`);
  }
  return stolen;
}

/**
 * Sources that have settled into permanent failure while their own markdown
 * stands intact — a deadlock rather than a collision.
 *
 * §6.1 names derivatives after their original, so two live sources on one stem
 * genuinely contend and one of them must lose; that is by design and permanent
 * by design. What is not by design is a source barred from ingesting when
 * nothing is actually competing for anything it needs — which is what happened
 * before derivatives were allowed to float: a rename whose destination held
 * another rename's markdown could neither carry nor re-extract, and a name swap
 * locked both sources out for good.
 *
 * The tell is that the blocked source has intact markdown of its own, recorded
 * and guard-confirmed: either directly, or under the old path it is pairing
 * from as a rename. A genuine collision loser has no such file — that is
 * exactly why it is trying to write one.
 */
async function deadlocked(fs: MemFs, result: CompileResult): Promise<string[]> {
  const manifest = manifestOf(fs);
  const found: string[] = [];

  const intact = async (owner: string, entry: ManifestEntry | undefined): Promise<boolean> => {
    const derivative = entry?.derivative;
    if (derivative === undefined || !fs.files.has(derivative)) return false;
    const origin = /^derived-from: (.*)$/m.exec(fs.text(derivative))?.[1]?.trim();
    return origin === owner;
  };

  for (const failure of result.failed) {
    if (!failure.path.startsWith("raw/")) continue;
    // Its own entry names markdown that is still its own.
    if (await intact(failure.path, manifest[failure.path])) {
      found.push(`${failure.path} (own markdown intact)`);
      continue;
    }
    // Or it is the new side of a rename, and the old side's markdown is intact.
    const bytes = fs.files.get(failure.path);
    if (bytes === undefined) continue;
    const hash = await sha256Hex(bytes);
    // Which vanished entry this source paired with is `bestPairing`'s judgement,
    // made with signals this check cannot see — and the generator produces
    // byte-identical sources on purpose, so the choice is often ambiguous.
    // Rather than guess it, require *every* candidate to have intact markdown:
    // then whichever one the run picked, this source had markdown to float and
    // should not have been left failing.
    const candidates = Object.entries(manifest).filter(
      ([old, entry]) =>
        old !== failure.path &&
        entry.hash === hash &&
        // A rename pairs from a path that has *gone*. An entry whose file is
        // still in the vault is a live source that merely shares these bytes.
        !fs.files.has(old),
    );
    if (candidates.length === 0) continue;
    let every = true;
    for (const [old, entry] of candidates) {
      if (!(await intact(old, entry)) && !(await intact(failure.path, entry))) every = false;
    }
    if (every) {
      found.push(`${failure.path} (markdown intact under ${candidates.map((c) => c[0]).join(", ")})`);
    }
  }
  return found;
}

/** Which pinned repairs this compile destroyed without saying anything. */
function repairsLost(
  fs: MemFs,
  pinned: ReadonlyMap<string, string>,
  result: CompileResult,
): string[] {
  if (result.reported.length > 0) return [];
  const manifest = manifestOf(fs);
  const lost: string[] = [];
  for (const [origin] of pinned) {
    const entry = manifest[origin];
    // Gone from the manifest under this path means deleted or renamed — the
    // sweep and the carry are covered by the convergence checks instead.
    if (entry?.derivative === undefined) continue;
    const now = fs.files.has(entry.derivative) ? fs.text(entry.derivative) : "";
    if (!now.includes(REPAIR_MARK)) lost.push(`${origin} -> ${entry.derivative}`);
  }
  return lost;
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

    if (roll < 0.34 && sources.length > 1) {
      // Two sources exchange names, each keeping its own extension: both old
      // paths vanish and both new ones appear, so this is two renames rather
      // than two edits. It is the one shape where each rename's destination
      // holds the other's markdown — the shape that used to lock both sources
      // out for good.
      const other = sources[Math.floor(pick() * sources.length)] as string;
      const cut = (path: string): [string, string] => {
        const dot = path.lastIndexOf(".");
        return dot > path.lastIndexOf("/") ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
      };
      const [stemA, extA] = cut(victim);
      const [stemB, extB] = cut(other);
      const toA = `${stemB}${extA}`;
      const toB = `${stemA}${extB}`;
      if (other !== victim && extA !== extB && !fs.files.has(toA) && !fs.files.has(toB)) {
        const a = fs.files.get(victim) as Uint8Array;
        const b = fs.files.get(other) as Uint8Array;
        fs.files.delete(victim);
        fs.files.delete(other);
        fs.files.set(toA, a);
        fs.files.set(toB, b);
      }
    } else if (roll < 0.40) {
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
      if (how < 0.4) await fs.write(file, `${fs.text(file)}\n${REPAIR_MARK}\n`);
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
          const pinned = await repairsBefore(fs);
          const marked = markedDerivatives(fs);
          try {
            const churned = await core(fs);
            const stolen = repairsStolen(fs, marked, churned);
            if (stolen.length > 0) {
              failures.push(`seed ${seed}: repair taken over silently ${JSON.stringify(stolen)}`);
            }
            // A repair may be lost — policy B says so — but the run has to
            // admit it. `failed` is not enough: that names work still owed,
            // whereas losing a repair is work already destroyed.
            const lost = repairsLost(fs, pinned, churned);
            if (lost.length > 0) {
              failures.push(
                `seed ${seed}: repair destroyed silently ${JSON.stringify(lost)} — ` +
                  JSON.stringify({ failed: churned.failed.map((e) => e.path) }),
              );
            }
          } catch {
            aborted += 1;
          }
        }

        // Then the trouble stops. Nothing else changes the vault.
        fs.failRate = 0;
        failPages = 0;
        const pinnedNow = await repairsBefore(fs);
        const markedNow = markedDerivatives(fs);
        const settling = await core(fs);
        const stolenNow = repairsStolen(fs, markedNow, settling);
        if (stolenNow.length > 0) {
          failures.push(`seed ${seed}: settling compile took over ${JSON.stringify(stolenNow)}`);
        }
        const lostNow = repairsLost(fs, pinnedNow, settling);
        if (lostNow.length > 0) {
          failures.push(`seed ${seed}: settling compile destroyed ${JSON.stringify(lostNow)}`);
          if (process.env.CHURN_DEBUG) {
            console.log("RESULT", JSON.stringify({
              added: settling.added, modified: settling.modified, renamed: settling.renamed,
              deleted: settling.deleted, unchanged: settling.unchanged,
              failed: settling.failed, reported: settling.reported,
            }, null, 1));
            console.log("MANIFEST", fs.text(MANIFEST));
            for (const f of fs.paths().filter((x) => x.startsWith("raw/"))) {
              console.log(">>", f, JSON.stringify(fs.text(f).slice(0, 110)));
            }
          }
        }
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
        // Nothing may settle into permanent failure while holding intact
        // markdown of its own: that is a deadlock, not a §6.1 collision.
        const stuck = await deadlocked(fs, results[2] as CompileResult);
        if (stuck.length > 0) {
          failures.push(`seed ${seed}: deadlocked ${JSON.stringify(stuck)}`);
          continue;
        }
        // Every manifest entry for a source that is still in the vault must name
        // markdown that is actually there. An entry whose *source* has gone is
        // a departure awaiting its cascade, or the old side of a rename whose
        // re-extraction has not settled — both are deliberately kept so the
        // work re-presents, and neither promises a file.
        for (const [path, entry] of Object.entries(manifestOf(fs))) {
          if (entry.hash === "cascade-pending") continue;
          if (!fs.files.has(path)) continue;
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
