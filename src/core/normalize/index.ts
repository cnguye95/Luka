// Normalization dispatch (handoff.md §6.1). Compile's later phases only ever
// receive markdown.
//
// Two shapes exist. Passthrough sources (md/txt) are annotated in place and
// hashed *afterwards* (§6.2). Every other format writes a derivative next to
// the original and the manifest hash is taken over the untouched original.
import type { FsAdapter, HttpAdapter } from "../adapters";
import { decodeUtf8, sha256Hex, utf8 } from "../hash";
import { dirname, extname, joinPath, stem } from "../paths";
import type { SourceFormat } from "../types";
import { ensureFrontmatter, parseFrontmatter, serializeFrontmatter } from "../yaml";
import { datasetToMarkdown } from "./dataset";
import { htmlToMarkdown } from "./html";
import { localizeInlineImages } from "./image";
import { pdfToMarkdown } from "./pdf";
import { repoContentHash, repoToMarkdown, selectRepoFiles } from "./repo";

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

/** `<original-stem>.md` beside the original; `null` when the format writes none. */
export function derivativePathFor(path: string, format: SourceFormat): string | null {
  if (isPassthrough(format) || format === "image") return null;
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
    const original = decodeUtf8(bytes);
    const annotated = ensureFrontmatter(original, {
      ingested: deps.today,
      "source-format": format,
    });
    const { text } = await localizeInlineImages(annotated, deps);
    if (text === original) {
      return { hash: await sha256Hex(bytes), derivativePath: null, wrote: false };
    }
    await deps.fs.write(path, text);
    return { hash: await sha256Hex(utf8(text)), derivativePath: null, wrote: true };
  }

  // Taken before normalization: the original is never annotated, so its bytes
  // are the identity, and no extractor can invalidate the value afterwards.
  const hash = await sha256Hex(bytes);

  let body: string;
  switch (format) {
    case "html":
      body = htmlToMarkdown(decodeUtf8(bytes));
      break;
    case "pdf":
      body = (await pdfToMarkdown(bytes)).text;
      break;
    case "dataset":
      body = datasetToMarkdown(decodeUtf8(bytes), path);
      break;
    default:
      throw new Error(`no M1 normalizer for source-format ${format}`);
  }

  const { text } = await localizeInlineImages(body, deps);
  const derivativePath = derivativePathFor(path, format) as string;
  await writeDerivative(derivativePath, text, path, format, deps);
  return { hash, derivativePath, wrote: true };
}

async function writeDerivative(
  target: string,
  body: string,
  origin: string,
  format: SourceFormat,
  deps: NormalizeDeps,
): Promise<void> {
  // A derivative may only ever overwrite another derivative of the same origin.
  // Anything else would be an unsanctioned write to a user-placed file.
  if (await deps.fs.exists(target)) {
    const existing = parseFrontmatter(decodeUtf8(await deps.fs.read(target)));
    const derivedFrom = existing.data["derived-from"];
    if (derivedFrom !== origin) {
      throw new Error(
        `derivative path ${target} is already taken by ${
          typeof derivedFrom === "string" ? `a derivative of ${derivedFrom}` : "a user-placed file"
        }`,
      );
    }
  }

  const frontmatter = serializeFrontmatter({
    ingested: deps.today,
    "source-format": format,
    "derived-from": origin,
  });
  const directory = dirname(target);
  if (directory !== "") await deps.fs.mkdir(directory);
  await deps.fs.write(target, frontmatter + body);
}
