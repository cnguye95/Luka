// Injection tests for the image localizer and the marker idiom.
//
// Both take strings Luka did not write — a URL from the source document, alt
// text from whoever wrote the markdown — and place them somewhere those strings
// have meaning: a `String.replace` replacement, and the inside of an HTML
// comment. What is asserted here is that neither placement lets the input mean
// something other than itself, and that the pass run over its own output
// changes nothing.
//
// A deterministic table covers each hostile token by name, so a failure says
// which one; the randomised loop after it covers combinations the table does
// not enumerate. FUZZ_LOCALIZE_SEEDS raises the seed count, FUZZ_LOCALIZE_FIRST
// pins one for a reproduction, FUZZ_LOCALIZE_DEBUG prints each vault.
import { describe, expect, it } from "vitest";
import { localizeInlineImages, ASSETS_FOLDER } from "../src/core/normalize/image";
import {
  imageNotFetched,
  linkOutsideRetrievedSet,
  normalizationSuspect,
  repoFileOmitted,
} from "../src/core/markers";
import { StubHttp, type StubRoute } from "./helpers/http";
import { MemFs } from "./helpers/memfs";
import { gifBytes, jpegBytes, pngBytes } from "./helpers/images";

const SEEDS = Number(process.env["FUZZ_LOCALIZE_SEEDS"] ?? 200);
const FIRST = Number(process.env["FUZZ_LOCALIZE_FIRST"] ?? 0);

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

/**
 * Each of these means something to `String.prototype.replace` when it lands in
 * a replacement string, and each can reach `assetPath` through the extension
 * `extensionFor` lifts out of the URL. `-->` additionally closes an HTML
 * comment.
 */
const HOSTILE = ["$&", "$`", "$'", "$1", "$$", "$<n>", "-->", "--->", "--"];

/**
 * Every markdown link target in the text, found without any knowledge of what
 * the localizer thinks alt text may contain.
 *
 * Deliberately not the product's own pattern: a check that reuses the regex it
 * is checking cannot notice that regex being wrong, which is exactly how the
 * bracketed-alt-text case slipped through.
 */
function linkTargets(text: string): string[] {
  return [...text.matchAll(/\]\(\s*([^\s)]+)/g)].map((match) => match[1] ?? "");
}

/** Every `<!--` on a line must be closed exactly once, at its end. */
function commentBreakouts(text: string): string[] {
  const bad: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("<!--")) continue;
    if (!trimmed.endsWith("-->")) bad.push(`unterminated: ${trimmed}`);
    if (trimmed.slice(0, -3).includes("-->")) bad.push(`closes early: ${trimmed}`);
  }
  return bad;
}

function imageRoute(bytes: Uint8Array, headers: Record<string, string> = {}): StubRoute {
  return { status: 200, headers, bytes };
}

/** Every asset written must be named by a link, and every link must name one. */
function pathMismatches(fs: MemFs, text: string): string[] {
  const bad: string[] = [];
  const named = new Set(linkTargets(text));
  for (const target of named) {
    if (target.startsWith(ASSETS_FOLDER) && !fs.files.has(target)) {
      bad.push(`link names ${JSON.stringify(target)}, which was never written`);
    }
  }
  for (const path of fs.paths()) {
    if (path.startsWith(ASSETS_FOLDER) && !named.has(path)) {
      bad.push(`wrote ${JSON.stringify(path)}, which no link names`);
    }
  }
  return bad;
}

describe("a localized link and the file it names are the same path", () => {
  // The extension is the one part of `assetPath` an outsider controls.
  for (const token of HOSTILE) {
    it(`survives a URL extension of ${JSON.stringify(token)}`, async () => {
      const url = `https://example.invalid/figure.${token}`;
      const fs = new MemFs();
      const http = new StubHttp({ [url]: imageRoute(pngBytes(200, 200)) });

      const result = await localizeInlineImages(`Prose.\n![a figure](${url})`, {
        fs,
        http,
        timeoutMs: 1000,
      });

      expect(pathMismatches(fs, result.text)).toEqual([]);
      expect(commentBreakouts(result.text)).toEqual([]);
    });
  }

  it("localizes an image whose alt text carries balanced brackets", async () => {
    const url = "https://example.invalid/figure.png";
    const fs = new MemFs();
    const http = new StubHttp({ [url]: imageRoute(pngBytes(200, 200)) });

    const result = await localizeInlineImages(`Prose.\n![a [b] c](${url})`, {
      fs,
      http,
      timeoutMs: 1000,
    });

    expect(result.localized).toBe(1);
    expect(pathMismatches(fs, result.text)).toEqual([]);
  });

  it("localizes an image whose alt text spans a line break", async () => {
    // Legal CommonMark: link text may contain a soft break. The pass must
    // either localize it or leave it alone entirely — fetching the bytes and
    // writing them into the vault while the prose still points at the remote
    // URL leaves a file nothing references.
    const url = "https://example.invalid/figure.png";
    const fs = new MemFs();
    const http = new StubHttp({ [url]: imageRoute(pngBytes(200, 200)) });

    const result = await localizeInlineImages(`Prose.\n![line\nbreak](${url})`, {
      fs,
      http,
      timeoutMs: 1000,
    });

    expect(pathMismatches(fs, result.text)).toEqual([]);
  });
});

describe("localizer and markers under randomised input", () => {
  it(`keeps link, file and comment honest, over ${SEEDS} seeds`, async () => {
    const failures: string[] = [];

    for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
      const next = rng(seed);
      const count = 1 + Math.floor(next() * 3);

      const urls: string[] = [];
      const lines: string[] = [];
      for (let n = 0; n < count; n += 1) {
        const stem = pick(next, ["pic", "diagram", "figure", "logo", "chart"]);
        const tail =
          next() < 0.7 ? `.${pick(next, HOSTILE)}` : pick(next, ["", ".png", ".jpg", ".WEBP"]);
        const url = `https://example.invalid/a${n}/${stem}${tail}`;
        urls.push(url);
        const alt = pick(next, [
          "",
          "a diagram",
          "before --> after",
          "$& $` $'",
          "logo",
          "]( x",
          // Balanced brackets are legal CommonMark link text on one line, and
          // excluding `]` to keep alt text line-bounded once excluded them too.
          "a [b] c",
          "[bracketed]",
          "a [b [c] d] e",
        ]);
        lines.push(`Prose about a${n}.`, `![${alt}](${url})`);
      }
      const source = lines.join("\n");

      const routes: Record<string, StubRoute> = {};
      for (const url of urls) {
        const roll = next();
        const bytes =
          roll < 0.4
            ? pngBytes(200, 200)
            : roll < 0.6
              ? jpegBytes(200, 200)
              : roll < 0.75
                ? gifBytes(200, 200)
                : roll < 0.85
                  ? pngBytes(10, 10) // under the dimension floor
                  : pngBytes(200, 200, 100); // under 5KB
        const typeRoll = next();
        const headers: Record<string, string> =
          typeRoll < 0.5
            ? { "content-type": "image/png" }
            : typeRoll < 0.75
              ? {}
              : { "content-type": "text/html" };
        routes[url] = { status: next() < 0.9 ? 200 : 404, headers, bytes };
      }

      const fs = new MemFs();
      const http = new StubHttp(routes);
      let result;
      try {
        result = await localizeInlineImages(source, { fs, http, timeoutMs: 1000 });
      } catch (error) {
        failures.push(`seed ${seed}: threw — ${String(error)}`);
        continue;
      }

      if (process.env["FUZZ_LOCALIZE_DEBUG"]) {
        console.log(`seed ${seed}\n  in : ${JSON.stringify(source)}`);
        console.log(`  out: ${JSON.stringify(result.text)}\n  had: ${JSON.stringify(fs.paths())}`);
      }

      for (const problem of pathMismatches(fs, result.text)) {
        failures.push(`seed ${seed}: ${problem}`);
      }
      for (const breakout of commentBreakouts(result.text)) {
        failures.push(`seed ${seed}: ${breakout}`);
      }

      // Running the pass over its own output must change nothing: markers are
      // re-derived rather than stacked, and a localized link is no longer remote.
      const again = await localizeInlineImages(result.text, { fs, http, timeoutMs: 1000 });
      if (again.text !== result.text) {
        failures.push(
          `seed ${seed}: not idempotent\n  once : ${JSON.stringify(result.text)}\n` +
            `  twice: ${JSON.stringify(again.text)}`,
        );
      }
    }

    if (failures.length > 0) {
      console.log(`\n${failures.length} failure(s) over ${SEEDS} seeds:\n`);
      for (const entry of failures.slice(0, 8)) console.log(entry, "\n");
    }
    expect(failures).toEqual([]);
  });

  it("keeps every marker inside its comment, whatever it is handed", () => {
    const failures: string[] = [];
    const values = HOSTILE.concat(["a -- b", "x --> y --> z", "line\r\nbreak", "  ", " x"]);

    for (const value of values) {
      const rendered = [
        imageNotFetched(value, value),
        repoFileOmitted(value, value),
        normalizationSuspect([value, value]),
        linkOutsideRetrievedSet(value),
      ];
      for (const marker of rendered) {
        if (marker.includes("\n") || marker.includes("\r")) {
          failures.push(`${JSON.stringify(value)}: marker spans lines — ${JSON.stringify(marker)}`);
        }
        for (const breakout of commentBreakouts(marker)) {
          failures.push(`${JSON.stringify(value)}: ${breakout}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
