// Normalization dispatch (handoff.md §6.1). Compile's later phases only ever
// receive markdown.
//
// Two shapes exist. Passthrough sources (md/txt) are annotated in place and
// hashed *afterwards* (§6.2). Every other format writes a derivative next to
// the original and the manifest hash is taken over the untouched original.
import type { FsAdapter, HttpAdapter } from "../adapters";
import {
  BOM_BYTES,
  bytesEqual,
  concatBytes,
  decodeUtf8,
  hasBom,
  sha256Hex,
  utf8,
} from "../hash";
import { normalizationSuspect } from "../markers";
import { basename, dirname, extname, joinPath, stem } from "../paths";
import type { LLMProvider } from "../provider/types";
import type { SourceFormat } from "../types";
import { ensureFrontmatter, parseFrontmatter, serializeFrontmatter } from "../yaml";
import { datasetToMarkdown } from "./dataset";
import { htmlToMarkdown } from "./html";
import { localizeInlineImages } from "./image";
import { pdfToMarkdown } from "./pdf";
import { repoContentHash, repoToMarkdown, selectRepoFiles } from "./repo";
import { smellPdfExtraction } from "./smell";

const FORMAT_BY_EXTENSION: Record<string, SourceFormat> = {
  ".md": "md",
  ".txt": "txt",
  ".html": "html",
  ".htm": "html",
  ".pdf": "pdf",
  ".csv": "dataset",
  ".tsv": "dataset",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
};

export function formatForPath(path: string): SourceFormat | null {
  return FORMAT_BY_EXTENSION[extname(path)] ?? null;
}

export function isPassthrough(format: SourceFormat): boolean {
  return format === "md" || format === "txt";
}

/**
 * `<original-stem>.md` beside the original; `null` when the format writes none.
 *
 * An orphan image writes one: §6.1's vision row keeps the original and adds a
 * markdown description, which makes the image a source like any other and
 * earns it a wiki page. Inline images never reach here — they are localized
 * into `raw/assets/` and are not sources at all.
 */
export function derivativePathFor(path: string, format: SourceFormat): string | null {
  if (isPassthrough(format)) return null;
  const directory = dirname(path);
  const name = `${stem(path)}.md`;
  return directory === "" ? name : joinPath(directory, name);
}

export interface NormalizeDeps {
  fs: FsAdapter;
  http: HttpAdapter;
  timeoutMs: number;
  /** ISO date recorded as `ingested`. */
  today: string;
  /** Required by the §6.1 vision row; unused by every other format. */
  provider: LLMProvider;
}

export interface NormalizeOutcome {
  /** The hash to record in the manifest. */
  hash: string;
  derivativePath: string | null;
  wrote: boolean;
}

export async function normalizeSource(
  path: string,
  format: SourceFormat,
  kind: "file" | "repo",
  deps: NormalizeDeps,
): Promise<NormalizeOutcome> {
  if (kind === "repo") {
    const files = await selectRepoFiles(deps.fs, path);
    const derivativePath = derivativePathFor(path, "repo") as string;
    await writeDerivative(derivativePath, repoToMarkdown(path, files), path, "repo", deps);
    return { hash: await repoContentHash(files), derivativePath, wrote: true };
  }

  const bytes = await deps.fs.read(path);

  if (isPassthrough(format)) {
    // The three sanctioned in-place writes (invariant 7), applied as one write.
    //
    // Annotation rewrites the whole file, so it is only safe when the bytes
    // survive a UTF-8 round trip. TextDecoder is non-fatal: it replaces every
    // invalid sequence with U+FFFD, so writing a decoded legacy-encoded file
    // back would silently destroy it. Such a source is still ingested — it is
    // simply left exactly as the user wrote it.
    const bom = hasBom(bytes);
    const content = bom ? bytes.subarray(BOM_BYTES.length) : bytes;
    const original = decodeUtf8(content);
    const unchanged = { hash: await sha256Hex(bytes), derivativePath: null, wrote: false };
    if (!bytesEqual(utf8(original), content)) return unchanged;

    const annotated = ensureFrontmatter(original, {
      ingested: deps.today,
      "source-format": format,
    });
    const { text } = await localizeInlineImages(annotated, deps);
    if (text === original) return unchanged;

    // The byte order mark is part of the file the user placed, so it is put back.
    const written = bom ? concatBytes([BOM_BYTES, utf8(text)]) : utf8(text);
    await deps.fs.write(path, written);
    return { hash: await sha256Hex(written), derivativePath: null, wrote: true };
  }

  // Taken before normalization: the original is never annotated, so its bytes
  // are the identity, and no extractor can invalidate the value afterwards.
  const hash = await sha256Hex(bytes);

  // Claimed before any extraction runs. §6.1 names every derivative
  // `<original-stem>.md`, so two non-passthrough sources sharing a stem
  // (`chart.csv` and `chart.png`) both want one file and the second cannot
  // have it. Checking afterwards would still fail — but only after paying for
  // the vision call, on every compile, forever, since a failed source is never
  // manifested (invariant 3).
  const derivativePath = derivativePathFor(path, format) as string;
  await claimDerivative(derivativePath, path, deps);

  let body: string;
  switch (format) {
    case "html":
      body = htmlToMarkdown(decodeUtf8(bytes));
      break;
    case "pdf": {
      const extraction = await pdfToMarkdown(bytes);
      // §6.5's smell test is PDF-only. The marker heads the body rather than
      // the file so the frontmatter block stays first, and it is re-derived
      // with the derivative on every run, so it never goes stale.
      const reasons = smellPdfExtraction(extraction);
      body =
        reasons.length === 0
          ? extraction.text
          : `${normalizationSuspect(reasons)}\n\n${extraction.text}`;
      break;
    }
    case "dataset":
      body = datasetToMarkdown(decodeUtf8(bytes), path);
      break;
    case "image":
      body = await describeImage(path, bytes, deps);
      break;
    default:
      throw new Error(`no normalizer for source-format ${format}`);
  }

  const { text } = await localizeInlineImages(body, deps);
  await writeDerivative(derivativePath, text, path, format, deps);
  return { hash, derivativePath, wrote: true };
}

/** §6.1's orphan-image set, mapped to the media types the vision API takes. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const VISION_SYSTEM = [
  "You are describing an image for a personal knowledge wiki.",
  "",
  "Rules:",
  "- Transcribe every piece of visible text faithfully and completely: notes on a",
  "  whiteboard, labels on a diagram, captions, handwriting. The transcription is",
  "  the most valuable part of your reply.",
  "- Describe the structure of any diagram: what the boxes and arrows connect.",
  "- Then describe what the image shows, in enough detail to stand in for it.",
  "- Reply with markdown prose only. No frontmatter, no headings repeating the",
  "  filename, no commentary about being an AI.",
].join("\n");

/**
 * §6.1's vision pass — exactly one model call per orphan image (invariant 12).
 * A failure propagates: the source is skipped with a notice (§11) and
 * invariant 3's success-only manifest retries it next compile.
 */
async function describeImage(
  path: string,
  bytes: Uint8Array,
  deps: NormalizeDeps,
): Promise<string> {
  const mediaType = IMAGE_MEDIA_TYPES[extname(path)];
  if (mediaType === undefined) throw new Error(`unsupported image type for ${path}`);

  const reply = await deps.provider.complete({
    task: "vision",
    system: VISION_SYSTEM,
    user: `Describe this image. Its filename is "${basename(path)}".`,
    images: [{ mediaType, data: bytes }],
  });

  const text = reply.trim();
  if (text === "") throw new Error(`vision returned no description for ${path}`);
  return `${text}\n`;
}

/**
 * Throws unless `target` is free for this origin's derivative.
 *
 * A derivative may only ever overwrite another derivative of the same origin;
 * anything else would be an unsanctioned write to a user-placed file
 * (invariant 7). Called before extraction so a doomed source never spends a
 * model call, and again inside `writeDerivative` so no caller can skip it.
 */
async function claimDerivative(
  target: string,
  origin: string,
  deps: NormalizeDeps,
): Promise<void> {
  if (!(await deps.fs.exists(target))) return;
  const existing = parseFrontmatter(decodeUtf8(await deps.fs.read(target)));
  const derivedFrom = existing.data["derived-from"];
  if (derivedFrom === origin) return;
  throw new Error(
    `derivative path ${target} is already taken by ${
      typeof derivedFrom === "string" ? `a derivative of ${derivedFrom}` : "a user-placed file"
    }`,
  );
}

async function writeDerivative(
  target: string,
  body: string,
  origin: string,
  format: SourceFormat,
  deps: NormalizeDeps,
): Promise<void> {
  await claimDerivative(target, origin, deps);

  const frontmatter = serializeFrontmatter({
    ingested: deps.today,
    "source-format": format,
    "derived-from": origin,
  });
  const directory = dirname(target);
  if (directory !== "") await deps.fs.mkdir(directory);
  await deps.fs.write(target, frontmatter + body);
}
