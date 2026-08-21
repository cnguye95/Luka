// Inline image localization (handoff.md §6.3).
//
// Remote references are fetched, filtered, and rewritten to a vault-local asset.
// Anything rejected keeps its original remote link and gains a marker — the pass
// is never destructive, and the wording is always "not fetched".
import type { FsAdapter, HttpAdapter } from "../adapters";
import { mapWithConcurrency } from "../concurrency";
import { sha256Hex } from "../hash";
import { imageNotFetched } from "../markers";
import { extname } from "../paths";

export const ASSETS_FOLDER = "raw/assets";

// handoff.md §17 marks all four fixed, so they are constants rather than settings.
const MIN_BYTES = 5 * 1024;
const MIN_DIMENSION = 100;
const FETCH_CONCURRENCY = 4;
const DECORATIVE = /logo|avatar|icon|sprite|badge|pixel/i;

/**
 * Inline markdown images: `![alt](url)`, with an optional quoted title.
 *
 * Alt text stops at a line break. CommonMark would allow one there, but the
 * rewrite below works a line at a time, so an image split across two lines is
 * one this pass cannot put back together — and matching it here would fetch
 * bytes into the vault that no link ever names. Both halves of the pass read
 * this one pattern, so they agree about what an image is by construction.
 *
 * Balanced brackets inside the alt text are allowed, because CommonMark allows
 * them and they say nothing about where the line ends. One level covers what a
 * person writes by hand; deeper nesting simply does not match, which leaves the
 * reference alone rather than mangling it.
 */
const IMAGE_MARKDOWN = /!\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*([^\s)]+)(?:\s+"[^"]*")?\s*\)/g;

export interface LocalizeDeps {
  fs: FsAdapter;
  http: HttpAdapter;
  timeoutMs: number;
}

export interface LocalizeResult {
  text: string;
  /** References rewritten to a vault-local asset. */
  localized: number;
  /** References left remote and marked. */
  marked: number;
}

type Decision = { keep: true; assetPath: string } | { keep: false; reason: string };

export async function localizeInlineImages(
  text: string,
  deps: LocalizeDeps,
): Promise<LocalizeResult> {
  const urls = new Map<string, string>();
  for (const match of text.matchAll(IMAGE_MARKDOWN)) {
    const url = match[2] ?? "";
    // Local paths and data: URIs are left untouched.
    if (!isRemote(url)) continue;
    if (!urls.has(url)) urls.set(url, match[1] ?? "");
  }
  if (urls.size === 0) return { text, localized: 0, marked: 0 };

  // Image markdown is dropped so a filename cannot vouch for itself, and so
  // are HTML comments: a marker from a previous run names the very file it
  // rejected, and reading that back would let "unreferenced in prose" become
  // "referenced" on the next compile purely because Luka had said so.
  const prose = text
    .replace(IMAGE_MARKDOWN, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .toLowerCase();
  const unique = [...urls.keys()];
  const decided = await mapWithConcurrency(unique, FETCH_CONCURRENCY, (url) =>
    decide(url, urls.get(url) ?? "", prose, deps),
  );
  const decisions = new Map<string, Decision>();
  unique.forEach((url, index) => decisions.set(url, decided[index] as Decision));

  const lines = text.split("\n");
  const rebuilt: string[] = [];
  let localized = 0;
  let marked = 0;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] as string;
    const pending: string[] = [];
    let hadRemoteImage = false;

    const rewritten = line.replace(IMAGE_MARKDOWN, (full, alt: string, url: string) => {
      if (!isRemote(url)) return full;
      const decision = decisions.get(url);
      if (!decision) return full;
      hadRemoteImage = true;
      if (decision.keep) {
        localized += 1;
        // Spliced at the offset of the link target, never by `String.replace`.
        // A string pattern takes the first occurrence in the whole match,
        // which is the alt text whenever the alt repeats the URL — that
        // rewrites prose the user owns and leaves the link remote, and since
        // the passthrough hash is taken after the write the file then reads as
        // unchanged for ever. A replacement string would additionally expand
        // `$&`, `` $` `` and `$'` out of the extension lifted from the URL.
        // `![` + alt + `]` is the shortest possible prefix, so the search
        // starts past it and cannot land inside the alt.
        const at = full.indexOf(url, alt.length + 3);
        if (at === -1) return full;
        return full.slice(0, at) + decision.assetPath + full.slice(at + url.length);
      }
      pending.push(imageNotFetched(imageName(url, alt), decision.reason));
      return full;
    });

    rebuilt.push(rewritten);
    index += 1;
    if (!hadRemoteImage) continue;

    // This run of comments belongs to the line just emitted. Luka's own image
    // markers in it are rewritten from scratch, so a marker never outlives the
    // problem it describes and never stacks a second copy when the reason
    // changes. Comments Luka did not write are preserved.
    const foreign: string[] = [];
    while (index < lines.length && isComment(lines[index] as string)) {
      const comment = lines[index] as string;
      if (!isImageMarker(comment)) foreign.push(comment);
      index += 1;
    }
    rebuilt.push(...pending, ...foreign);
    marked += pending.length;
  }

  return { text: rebuilt.join("\n"), localized, marked };
}

async function decide(
  url: string,
  alt: string,
  prose: string,
  deps: LocalizeDeps,
): Promise<Decision> {
  let response;
  try {
    response = await deps.http.request({ url, timeoutMs: deps.timeoutMs });
  } catch (error) {
    return { keep: false, reason: `fetch failed, ${failureKind(error)}` };
  }

  if (response.status < 200 || response.status >= 300) {
    return { keep: false, reason: `fetch failed, HTTP ${response.status}` };
  }

  const contentType = (response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  // An absent content-type is uncertain, not disqualifying.
  if (contentType !== undefined && contentType !== "" && !contentType.startsWith("image/")) {
    return { keep: false, reason: `not an image, content-type ${contentType}` };
  }

  const size = sniffImageSize(response.bytes);
  if (size !== null && size.width < MIN_DIMENSION && size.height < MIN_DIMENSION) {
    return { keep: false, reason: `under ${MIN_DIMENSION}×${MIN_DIMENSION}` };
  }
  if (response.bytes.length < MIN_BYTES) {
    return { keep: false, reason: "under 5KB" };
  }
  if (isDecorative(url, alt) && !proseReferences(url, alt, prose)) {
    return { keep: false, reason: "decorative name, unreferenced in prose" };
  }

  const assetPath = `${ASSETS_FOLDER}/${await sha256Hex(response.bytes)}${extensionFor(
    contentType ?? "",
    url,
  )}`;
  await deps.fs.mkdir(ASSETS_FOLDER);
  if (!(await deps.fs.exists(assetPath))) await deps.fs.write(assetPath, response.bytes);
  return { keep: true, assetPath };
}

/**
 * Width and height read from header bytes, without decoding the image.
 * `null` means "could not tell", which the caller treats as keep.
 */
export function sniffImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: 8-byte signature, then an IHDR chunk whose width/height are big-endian.
  if (bytes.length >= 24 && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // GIF: logical screen descriptor, little-endian.
  if (bytes.length >= 10 && startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  // JPEG: walk the segment chain to the start-of-frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] as number;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const isStartOfFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + view.getUint16(offset + 2);
    }
    return null;
  }

  // WebP: RIFF container, then one of three VP8 chunk flavours.
  if (bytes.length >= 30 && startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === "WEBP") {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === "VP8X") {
      return {
        width: uint24LE(view, 24) + 1,
        height: uint24LE(view, 27) + 1,
      };
    }
    if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
  }

  return null;
}

function isRemote(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function urlPathname(url: string): string {
  return url.replace(/[?#].*$/, "");
}

/** The filename the marker names, falling back to alt text and then the URL. */
function imageName(url: string, alt: string): string {
  const last = urlPathname(url).split("/").filter(Boolean).pop();
  if (last !== undefined && last !== "") return last;
  return alt !== "" ? alt : url;
}

function isDecorative(url: string, alt: string): boolean {
  return DECORATIVE.test(imageName(url, "")) || DECORATIVE.test(alt);
}

function proseReferences(url: string, alt: string, prose: string): boolean {
  const name = imageName(url, "");
  const stemOfName = name.replace(/\.[^.]*$/, "");
  const candidates = [alt, stemOfName].filter((c) => c.length >= 3);
  return candidates.some((c) => prose.includes(c.toLowerCase()));
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
};

function extensionFor(contentType: string, url: string): string {
  const byType = EXTENSION_BY_TYPE[contentType];
  if (byType !== undefined) return byType;
  const byUrl = extname(urlPathname(url));
  if (byUrl !== "") return byUrl;
  if (contentType.startsWith("image/")) {
    const subtype = contentType.slice("image/".length).replace(/[^a-z0-9]/g, "");
    if (subtype !== "") return `.${subtype}`;
  }
  return ".img";
}

function failureKind(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Kept coarse so the annotation is stable across environments and reruns.
  return /timeout|timed out|abort/i.test(message) ? "timeout" : "network error";
}

function isComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("<!--") && trimmed.endsWith("-->");
}

function isImageMarker(line: string): boolean {
  return line.trim().startsWith("<!-- image not fetched:");
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] as number);
  return out;
}

function uint24LE(view: DataView, offset: number): number {
  return view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
}
