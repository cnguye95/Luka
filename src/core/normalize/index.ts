// Normalization dispatch. Compile's later phases only ever
// receive markdown.
//
// Two shapes exist. Passthrough sources (md/txt) are annotated in place and
// hashed *afterwards*. Every other format writes a derivative next to
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
 * An orphan image writes one: the vision pass keeps the original and adds a
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
  /** Required by the vision pass; unused by every other format. */
  provider: LLMProvider;
}

export interface NormalizeOutcome {
  /** The hash to record in the manifest. */
  hash: string;
  derivativePath: string | null;
  wrote: boolean;
}

/**
 * `acceptOrigins` widens the invariant-7 write guard beyond this source's own
 * path. A rename whose derivative could not be carried re-extracts instead, and
 * for an extension-only rename (`data.csv` -> `data.tsv`) the file standing in
 * the way is its *own* previous derivative, still naming the old path. Naming
 * that path here is what lets the re-extraction proceed; every other file is
 * still refused. Empty means "this source only", which is every ordinary call.
 *
 * `recordedDerivative` is the manifest entry's pointer, when there is one. It
 * is where this source's markdown actually is, which after a float is not
 * `<stem>.md` — see `chooseTarget`.
 */
export async function normalizeSource(
  path: string,
  format: SourceFormat,
  kind: "file" | "repo",
  deps: NormalizeDeps,
  acceptOrigins: readonly string[] = [],
  recordedDerivative?: string,
): Promise<NormalizeOutcome> {
  const accepted = [path, ...acceptOrigins];
  if (kind === "repo") {
    const files = await selectRepoFiles(deps.fs, path);
    const canonical = derivativePathFor(path, "repo") as string;
    const derivativePath = await chooseTarget(canonical, recordedDerivative, accepted, deps);
    await writeDerivative(derivativePath, repoToMarkdown(path, files), path, "repo", accepted, deps);
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

  // Claimed before any extraction runs. Every derivative is named
  // `<original-stem>.md`, so two non-passthrough sources sharing a stem
  // (`chart.csv` and `chart.png`) both want one file and the second cannot
  // have it. Checking afterwards would still fail — but only after paying for
  // the vision call, on every compile, forever, since a failed source is never
  // manifested (invariant 3).
  const derivativePath = await chooseTarget(
    derivativePathFor(path, format) as string,
    recordedDerivative,
    accepted,
    deps,
  );

  let body: string;
  switch (format) {
    case "html":
      body = htmlToMarkdown(decodeUtf8(bytes));
      break;
    case "pdf": {
      const extraction = await pdfToMarkdown(bytes);
      // The smell test is PDF-only. The marker heads the body rather than
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
  await writeDerivative(derivativePath, text, path, format, accepted, deps);
  return { hash, derivativePath, wrote: true };
}

/** The orphan-image set, mapped to the media types the vision API takes. */
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
 * The vision pass — exactly one model call per orphan image (invariant 12).
 * A failure propagates: the source is skipped with a notice and
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
 * Where this normalization writes.
 *
 * `<stem>.md` first, always: it is canonical, and a derivative sitting where its
 * source's name says it should is the one a user can find. The claim is made
 * before any extraction runs, so a doomed source never spends a model call.
 *
 * When that path is refused and the entry records this source's own markdown
 * somewhere else — a float (rename invariant VII) — the write goes there
 * instead. That file is this source's, confirmed by the same guard that refuses
 * everyone else's, and rewriting it is invariant 7's plain sentence: derivative
 * files Luka wrote are Luka's to rewrite. Nothing is widened; the only address
 * ever reached this way is one the manifest already recorded for this very
 * source.
 *
 * Canonical-first is also what makes floats temporary. A floated source that is
 * edited lands back at `<stem>.md` the moment the obstruction clears, and the
 * file it vacated is swept at the commit point behind the ownership guard.
 *
 * An *empty* non-canonical path is never taken: fresh placement belongs to
 * normalization; a float is only ever the continuation of an existing file.
 *
 * Only a *refusal* redirects the write. An IO failure is not a judgement about
 * who owns the canonical path, and acting on it as though it were would move a
 * write somewhere else on a transient blip, silently — the same distinction
 * the missing-derivative test draws between an unreadable document and an
 * unreadable disk.
 */
async function chooseTarget(
  canonical: string,
  recorded: string | undefined,
  accepted: readonly string[],
  deps: NormalizeDeps,
): Promise<string> {
  try {
    await claimDerivative(canonical, accepted, deps);
    return canonical;
  } catch (refusal) {
    if (!(refusal instanceof DerivativeTaken)) throw refusal;
    if (recorded !== undefined && recorded !== canonical) {
      const origin = await derivativeOrigin(deps.fs, recorded);
      if (origin !== null && accepted.includes(origin)) return recorded;
    }
    // The canonical refusal is the honest story: nothing of this source's own
    // stands anywhere else to continue.
    throw refusal;
  }
}

/**
 * The source path a file names as its origin, or `null` if it is not a
 * derivative at all — not a file, no readable frontmatter, or no `derived-from`
 * key. The single reader of that key in the codebase.
 *
 * Rename invariant II: this answers "whose is the file at this path", never
 * "where is this source's file". It is read as a guard, immediately before a
 * destructive write or before serving a file as a source's content, and its
 * answer is never used to locate anything.
 */
export async function derivativeOrigin(fs: FsAdapter, path: string): Promise<string | null> {
  const stat = await fs.stat(path);
  if (stat === null || stat.kind !== "file") return null;
  // A vault that cannot be read is a different answer from a file that is not
  // ours, and callers act on the two very differently — one is worth a retry,
  // the other never is. Only an unreadable *document* is answered here; an
  // unreadable *disk* is the caller's to handle.
  const bytes = await fs.read(path);
  try {
    const { data } = parseFrontmatter(decodeUtf8(bytes));
    return typeof data["derived-from"] === "string" ? data["derived-from"] : null;
  } catch {
    return null;
  }
}

/**
 * The canonical path is held by a file this source may not overwrite. A
 * judgement about ownership, distinct from an IO failure — `chooseTarget` acts
 * on the first and never on the second.
 */
class DerivativeTaken extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerivativeTaken";
  }
}

/**
 * Throws unless `target` is free for this source's derivative.
 *
 * A derivative may only ever overwrite a derivative of an origin on the
 * accepted list; anything else would be an unsanctioned write to a user-placed
 * file (invariant 7). Called before extraction so a doomed source never spends
 * a model call, and again inside `writeDerivative` so no caller can skip it.
 */
async function claimDerivative(
  target: string,
  accepted: readonly string[],
  deps: NormalizeDeps,
): Promise<void> {
  if (!(await deps.fs.exists(target))) return;
  const derivedFrom = await derivativeOrigin(deps.fs, target);
  if (derivedFrom !== null && accepted.includes(derivedFrom)) return;
  throw new DerivativeTaken(
    `derivative path ${target} is already taken by ${
      derivedFrom === null ? "a user-placed file" : `a derivative of ${derivedFrom}`
    }`,
  );
}

async function writeDerivative(
  target: string,
  body: string,
  origin: string,
  format: SourceFormat,
  accepted: readonly string[],
  deps: NormalizeDeps,
): Promise<void> {
  await claimDerivative(target, accepted, deps);

  const frontmatter = serializeFrontmatter({
    ingested: deps.today,
    "source-format": format,
    "derived-from": origin,
  });
  const directory = dirname(target);
  if (directory !== "") await deps.fs.mkdir(directory);
  await deps.fs.write(target, frontmatter + body);
}
