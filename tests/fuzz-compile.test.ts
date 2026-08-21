// Hostile bytes through the whole M1 pipeline.
//
// Everything under `raw/` is content Luka did not write: a user drops files in
// and compile has to survive them. The properties asserted here are the ones
// that hold no matter what those bytes are — compile finishes, the vault
// settles, and nothing a user placed is altered except by the three writes
// invariant 7 sanctions.
//
// FUZZ_SEEDS raises the seed count, FUZZ_FIRST pins one for a reproduction.
import { describe, expect, it } from "vitest";
import { createCore } from "../src/core/index";
import { DEFAULT_SETTINGS } from "../src/core/types";
import { loadManifest } from "../src/core/manifest";
import { parseFrontmatter } from "../src/core/yaml";
import { StubHttp } from "./helpers/http";
import { MemFs } from "./helpers/memfs";
import { StubProvider, inventoryReply } from "./helpers/provider";
import { gifBytes, jpegBytes, pngBytes } from "./helpers/images";

const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";
const SEEDS = Number(process.env["FUZZ_SEEDS"] ?? 150);
const FIRST = Number(process.env["FUZZ_FIRST"] ?? 0);

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

const pick = <T>(next: () => number, from: readonly T[]): T =>
  from[Math.floor(next() * from.length)] as T;

const bytes = (...parts: (number[] | Uint8Array)[]): Uint8Array => {
  const flat: number[] = [];
  for (const part of parts) flat.push(...part);
  return new Uint8Array(flat);
};

const utf8 = (s: string) => new TextEncoder().encode(s);
const BOM = [0xef, 0xbb, 0xbf];

/** Frontmatter blocks that have historically been able to surprise a parser. */
const HOSTILE_FRONTMATTER = [
  "---\n__proto__:\n  polluted: yes\n---\n",
  "---\nconstructor:\n  prototype:\n    x: 1\n---\n",
  "---\ntoString: not a function\n---\n",
  "---\na: &anchor {k: v}\nb: *anchor\nc: *anchor\n---\n",
  "---\n" + "a: {".repeat(60) + "}".repeat(60) + "\n---\n",
  "---\n- just\n- a\n- sequence\n---\n",
  "---\njust a scalar\n---\n",
  "---\nkey: |\n  folded\n  block\n---\n",
  "---\nunterminated: 'quote\n---\n",
  // A closing fence that is not at a line start. This made parseFrontmatter
  // report a `derived-from` the document does not carry, which is how a user's
  // own file was accepted as Luka's and overwritten.
  "---\nderived-from: raw/elsewhere.pdf---\n",
  // A `---` line inside a block scalar, which truncated the parse and lost
  // every key below it — the ownership key included.
  "---\nnote: |\n  ---\nderived-from: raw/elsewhere.pdf\n---\n",
  "---\nderived-from: raw/somewhere.csv\n---\n",
  "---\ningested: '2026-01-01'\nsource-format: md\n---\n",
  "",
];

/** Text bodies carrying things that mean something to a later reader. */
const HOSTILE_BODY = [
  "Plain enough.\n",
  "A comment breaker --> right here.\n",
  "<!-- unterminated comment\n",
  "![img](https://example.invalid/a.$&)\n",
  "![img](https://example.invalid/logo.png)\n",
  "A [[wikilink]] and a `fence`.\n",
  "```\n<!-- fenced --> comment\n```\n",
  "Ends without a newline",
  "\n\n\n",
];

function markdownSource(next: () => number): Uint8Array {
  const text = pick(next, HOSTILE_FRONTMATTER) + pick(next, HOSTILE_BODY);
  const roll = next();
  if (roll < 0.12) return bytes(BOM, utf8(text)); // byte order mark
  if (roll < 0.2) return bytes(utf8(text), [0xff, 0xfe, 0x00]); // not valid UTF-8
  if (roll < 0.26) return bytes([0xff, 0xfe], utf8(text)); // UTF-16-ish lead
  return utf8(text);
}

function csvSource(next: () => number): Uint8Array {
  const roll = next();
  if (roll < 0.3) {
    // Ragged: one wide header, then narrow rows.
    const header = Array.from({ length: 40 }, (_, i) => `c${i}`).join(",");
    const rows = Array.from({ length: 30 }, (_, i) => `${i}`).join("\n");
    return utf8(`${header}\n${rows}\n`);
  }
  if (roll < 0.5) return utf8('a,b\n"unterminated,2\n3,4\n');
  if (roll < 0.65) return utf8("\n\n\n");
  if (roll < 0.8) return utf8('a,b\n"has ""quotes"" and, commas",2\n');
  return utf8("a,b\n1,2\n3,4\n");
}

function htmlSource(next: () => number): Uint8Array {
  const roll = next();
  if (roll < 0.25) return utf8("<div>".repeat(120) + "deep" + "</div>".repeat(120));
  if (roll < 0.4) return utf8("<p>A comment breaker --> here</p>");
  if (roll < 0.55) return utf8("<p>unclosed <b>bold");
  if (roll < 0.7) return utf8("<!-- <p>all commented</p> -->");
  return utf8("<h1>Title</h1><p>Body text.</p>");
}

function imageSource(next: () => number): Uint8Array {
  const roll = next();
  if (roll < 0.25) return pngBytes(200, 200);
  if (roll < 0.4) return jpegBytes(200, 200);
  if (roll < 0.5) return gifBytes(200, 200);
  // Headers that lie about their own structure.
  if (roll < 0.65) return bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0xff, 0xff, 0xff, 0xff]);
  if (roll < 0.8) return bytes([0xff, 0xd8, 0xff, 0xc0, 0xff, 0xff], new Uint8Array(200));
  return new Uint8Array(Array.from({ length: 300 }, (_, i) => i % 256));
}

/** Names that are legal on disk but mean something to a marker or a link. */
const STEMS = ["note", "a b", "dash-name", "comment-->breaker", "logo", "dup"];

function buildVault(next: () => number): Record<string, string | Uint8Array> {
  const vault: Record<string, string | Uint8Array> = {};
  const count = 1 + Math.floor(next() * 4);

  for (let n = 0; n < count; n += 1) {
    const stem = pick(next, STEMS);
    const folder = next() < 0.25 ? "raw/sub" : "raw";
    const kind = next();
    if (kind < 0.3) vault[`${folder}/${stem}${n}.md`] = markdownSource(next);
    else if (kind < 0.45) vault[`${folder}/${stem}${n}.txt`] = markdownSource(next);
    else if (kind < 0.6) vault[`${folder}/${stem}${n}.html`] = htmlSource(next);
    else if (kind < 0.75) vault[`${folder}/${stem}${n}.csv`] = csvSource(next);
    else if (kind < 0.9) vault[`${folder}/${stem}${n}.png`] = imageSource(next);
    else vault[`${folder}/${stem}${n}.zip`] = new Uint8Array([1, 2, 3]); // unsupported
  }

  // Sometimes a manifest is already there, and sometimes it is hostile.
  const manifestRoll = next();
  if (manifestRoll < 0.15) {
    vault[MANIFEST] = JSON.stringify({ __proto__: { hash: "0".repeat(64) }, "raw/x.md": "abc" });
  } else if (manifestRoll < 0.25) {
    vault[MANIFEST] = JSON.stringify(["not", "an", "object"]);
  } else if (manifestRoll < 0.32) {
    vault[MANIFEST] = "{ not json at all";
  }

  return vault;
}

function core(fs: MemFs) {
  return createCore({
    fs,
    http: new StubHttp({}),
    manifestPath: MANIFEST,
    settings: { ...DEFAULT_SETTINGS, apiKey: "test-key" },
    now: () => new Date("2026-08-19T10:00:00Z"),
    provider: new StubProvider((request: { task: string }) =>
      request.task === "page-generation"
        ? "Body.\n"
        : request.task === "vision"
          ? "An image.\n"
          : inventoryReply("A source.", []),
    ),
  }).compile();
}

const PASSTHROUGH = /\.(md|txt)$/;
/** The three sanctioned in-place writes touch md/txt sources only. */
const mayBeRewritten = (path: string) => PASSTHROUGH.test(path);

function snapshot(fs: MemFs): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of fs.paths()) {
    const raw = fs.files.get(path) as Uint8Array;
    out.set(path, [...raw].join(","));
  }
  return out;
}

/** Luka's own markers must each be one well-formed comment on one line. */
const MARKER = /<!--\s*(image not fetched|repo file omitted|normalization suspect|truncated for|dataset columns omitted|source with no content)/;

function markerBreakouts(fs: MemFs): string[] {
  const bad: string[] = [];
  for (const path of fs.paths()) {
    if (!path.endsWith(".md")) continue;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(fs.files.get(path) as Uint8Array);
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!MARKER.test(line)) continue;
      const trimmed = line.trim();
      if (!trimmed.endsWith("-->")) bad.push(`${path}: unterminated marker — ${trimmed}`);
      else if (trimmed.slice(0, -3).includes("-->")) bad.push(`${path}: marker closes early — ${trimmed}`);
    }
  }
  return bad;
}

describe("parsed objects keep their prototype", () => {
  const HOSTILE_JSON = [
    '{"__proto__": {"hash": "aaa"}, "raw/a.md": {"hash": "bbb"}}',
    '{"__proto__": "aaa", "raw/a.md": "bbb"}',
    '{"constructor": {"hash": "aaa"}}',
    '{"raw/a.md": {"hash": "aaa", "__proto__": {"x": 1}}}',
  ];

  for (const json of HOSTILE_JSON) {
    it(`loadManifest over ${json.slice(0, 34)}…`, async () => {
      const fs = new MemFs({ [MANIFEST]: json });
      const manifest = await loadManifest(fs, MANIFEST);

      // A key an outsider chose must never decide what this object inherits.
      expect(Object.getPrototypeOf(manifest)).toBe(Object.prototype);
      // And it must not have leaked onto every object in the process.
      expect(({} as Record<string, unknown>)["hash"]).toBeUndefined();
    });
  }

  for (const block of HOSTILE_FRONTMATTER) {
    it(`parseFrontmatter over ${JSON.stringify(block.slice(0, 30))}…`, () => {
      const parsed = parseFrontmatter(`${block}Body.\n`);
      expect(Object.getPrototypeOf(parsed.data)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    });
  }
});

// Generous, because FUZZ_SEEDS raises the work far past vitest's default.
describe("hostile bytes under raw/", { timeout: 600_000 }, () => {
  it(`compile survives, settles and preserves, over ${SEEDS} seeds`, async () => {
    const failures: string[] = [];

    for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
      const next = rng(seed);
      const seeded = buildVault(next);
      const fs = new MemFs(seeded);
      const before = snapshot(fs);

      // (1) Whatever the bytes are, compile finishes.
      try {
        await core(fs);
      } catch (error) {
        failures.push(`seed ${seed}: compile threw — ${String(error)}`);
        continue;
      }

      // (2) Nothing a user placed is altered, except md/txt which invariant 7
      //     allows three specific writes to.
      for (const [path, bytesBefore] of before) {
        if (path === MANIFEST || mayBeRewritten(path)) continue;
        const after = fs.files.get(path);
        if (after === undefined) {
          failures.push(`seed ${seed}: ${path} was removed`);
        } else if ([...after].join(",") !== bytesBefore) {
          failures.push(`seed ${seed}: ${path} was rewritten`);
        }
      }

      for (const breakout of markerBreakouts(fs)) failures.push(`seed ${seed}: ${breakout}`);

      // (3) The vault settles: one more compile finishes the work, and the one
      //     after it does nothing at all.
      let second, third;
      try {
        second = await core(fs);
        const settled = snapshot(fs);
        third = await core(fs);
        const again = snapshot(fs);
        if (JSON.stringify([...settled]) !== JSON.stringify([...again])) {
          failures.push(`seed ${seed}: vault still changing on the third compile`);
        }
      } catch (error) {
        failures.push(`seed ${seed}: later compile threw — ${String(error)}`);
        continue;
      }

      if (!third.noop) {
        failures.push(
          `seed ${seed}: third compile did work — ${JSON.stringify({
            added: third.added,
            modified: third.modified,
            failed: third.failed.map((f) => f.reason),
          })}`,
        );
      }
      if (third.modelCalls !== 0) {
        failures.push(`seed ${seed}: settled vault made ${third.modelCalls} model calls`);
      }
      const settledFailures = JSON.stringify(second.failed.map((f) => f.path).sort());
      const laterFailures = JSON.stringify(third.failed.map((f) => f.path).sort());
      if (settledFailures !== laterFailures) {
        failures.push(`seed ${seed}: failures unstable — ${settledFailures} then ${laterFailures}`);
      }
    }

    if (failures.length > 0) {
      console.log(`\n${failures.length} failure(s) over ${SEEDS} seeds:\n`);
      for (const entry of failures.slice(0, 10)) console.log(entry, "\n");
    }
    expect(failures).toEqual([]);
  });
});
