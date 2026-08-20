// Source discovery and the four change-detection rules (handoff.md §4, §6.2).
//
// Who is a source: everything under raw/ except raw/assets/ and except files
// carrying `derived-from`. A repo directory is one source and is never
// descended into. Identity is SHA-256 of content; timestamps are never used.
import type { FsAdapter } from "../adapters";
import { decodeUtf8, sha256Hex } from "../hash";
import { derivativePathFor, formatForPath } from "../normalize/index";
import { ASSETS_FOLDER } from "../normalize/image";
import { isRepoDirectory, repoContentHash, selectRepoFiles } from "../normalize/repo";
import { extname, isUnder } from "../paths";
import type { IngestManifest, SourceFormat } from "../types";
import { parseFrontmatter } from "../yaml";

export const RAW_FOLDER = "raw";

export interface DiscoveredSource {
  path: string;
  kind: "file" | "repo";
  format: SourceFormat;
  hash: string;
}

export interface SkippedSource {
  path: string;
  reason: string;
}

export interface Rename {
  from: string;
  to: string;
  hash: string;
}

export interface DiscoveryResult {
  added: DiscoveredSource[];
  modified: DiscoveredSource[];
  unchanged: DiscoveredSource[];
  deleted: string[];
  renamed: Rename[];
  /** Never manifested, so they resurface next compile rather than failing silently. */
  skipped: SkippedSource[];
}

export async function discover(fs: FsAdapter, manifest: IngestManifest): Promise<DiscoveryResult> {
  const { sources, skipped } = await collectSources(fs);
  const present = new Map(sources.map((source) => [source.path, source]));

  const added: DiscoveredSource[] = [];
  const modified: DiscoveredSource[] = [];
  const unchanged: DiscoveredSource[] = [];

  for (const source of sources) {
    const recorded = manifest[source.path];
    if (recorded === undefined) {
      added.push(source);
    } else if (recorded !== source.hash || !(await hasDerivative(fs, source))) {
      // §6.2: a manifested source whose derivative went missing reprocesses as modified.
      modified.push(source);
    } else {
      unchanged.push(source);
    }
  }

  const vanished = Object.keys(manifest)
    .filter((path) => !present.has(path))
    .sort();

  const { renamed, remainingAdded, remainingDeleted } = pairRenames(added, vanished, manifest);

  // A rename skips regeneration, but only if the derivative already sits at the
  // new path; otherwise the missing-derivative rule wins and it reprocesses.
  const renames: Rename[] = [];
  for (const rename of renamed) {
    const source = present.get(rename.to) as DiscoveredSource;
    if (await hasDerivative(fs, source)) {
      renames.push(rename);
    } else {
      modified.push(source);
      remainingDeleted.push(rename.from);
    }
  }

  return {
    added: remainingAdded.sort(byPath),
    modified: modified.sort(byPath),
    unchanged: unchanged.sort(byPath),
    deleted: remainingDeleted.sort(),
    renamed: renames.sort((a, b) => a.to.localeCompare(b.to)),
    skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

async function hasDerivative(fs: FsAdapter, source: DiscoveredSource): Promise<boolean> {
  const derivative = derivativePathFor(source.path, source.format);
  if (derivative === null) return true;
  return fs.exists(derivative);
}

/**
 * Same hash gone from one path and appeared at another. Pairs are formed in
 * lexicographic order so the outcome does not depend on walk order.
 */
function pairRenames(
  added: readonly DiscoveredSource[],
  vanished: readonly string[],
  manifest: IngestManifest,
): { renamed: Rename[]; remainingAdded: DiscoveredSource[]; remainingDeleted: string[] } {
  const vanishedByHash = new Map<string, string[]>();
  for (const path of vanished) {
    const hash = manifest[path] as string;
    const bucket = vanishedByHash.get(hash);
    if (bucket) bucket.push(path);
    else vanishedByHash.set(hash, [path]);
  }

  const renamed: Rename[] = [];
  const remainingAdded: DiscoveredSource[] = [];
  const claimed = new Set<string>();

  for (const source of [...added].sort(byPath)) {
    const bucket = vanishedByHash.get(source.hash);
    const from = bucket?.shift();
    if (from === undefined) {
      remainingAdded.push(source);
      continue;
    }
    claimed.add(from);
    renamed.push({ from, to: source.path, hash: source.hash });
  }

  return {
    renamed,
    remainingAdded,
    remainingDeleted: vanished.filter((path) => !claimed.has(path)),
  };
}

async function collectSources(
  fs: FsAdapter,
): Promise<{ sources: DiscoveredSource[]; skipped: SkippedSource[] }> {
  const sources: DiscoveredSource[] = [];
  const skipped: SkippedSource[] = [];

  if (!(await fs.exists(RAW_FOLDER))) return { sources, skipped };

  const directories = [RAW_FOLDER];
  while (directories.length > 0) {
    const directory = directories.pop() as string;
    for (const entry of await fs.list(directory)) {
      if (entry.kind === "folder") {
        if (isUnder(entry.path, ASSETS_FOLDER)) continue;
        if (await isRepoDirectory(fs, entry.path)) {
          const files = await selectRepoFiles(fs, entry.path);
          sources.push({
            path: entry.path,
            kind: "repo",
            format: "repo",
            hash: await repoContentHash(files),
          });
          continue;
        }
        directories.push(entry.path);
        continue;
      }

      const format = formatForPath(entry.path);
      if (format === null) {
        skipped.push({ path: entry.path, reason: "unsupported file type" });
        continue;
      }
      const bytes = await fs.read(entry.path);
      // Only Luka writes derivatives, and it only ever writes `.md`.
      if (extname(entry.path) === ".md") {
        const { data } = parseFrontmatter(decodeUtf8(bytes));
        if (typeof data["derived-from"] === "string") continue;
      }

      sources.push({
        path: entry.path,
        kind: "file",
        format,
        hash: await sha256Hex(bytes),
      });
    }
  }

  return { sources, skipped };
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path.localeCompare(b.path);
}
