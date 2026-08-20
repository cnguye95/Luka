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
  // new path; otherwise §6.2's missing-derivative rule applies as well and the
  // source reprocesses.
  //
  // The two rules compose rather than compete: it is still a rename, so the
  // manifest path and every wiki reference follow the file, and it is *also*
  // modified, so it re-normalizes at its new path. Reporting the old path as
  // deleted instead would hand §6.6's cascade a source that never went away —
  // and moving a file into a subfolder, which leaves the derivative behind and
  // so always lands here, would delete the very pages that cite it.
  const renames: Rename[] = [];
  for (const rename of renamed) {
    const source = present.get(rename.to) as DiscoveredSource;
    renames.push(rename);
    // The derivative may still carry the old path as its origin: an
    // extension-only rename leaves it at the same location, so it is this
    // source's derivative under its previous name. Compile repoints the key.
    if (!(await hasDerivative(fs, source, rename.from))) modified.push(source);
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

/**
 * §6.2's missing-derivative test. Ownership, not mere existence: the file at
 * that path counts only if its `derived-from` names this source.
 *
 * Sources sharing a stem share the location, and a user's own note can sit
 * there too. Accepting a stranger's file would mark the source ingested while
 * its readable markdown does not exist — the §6.6 sweep would then delete the
 * real derivative as an orphan, and every later compile would read the source
 * as unchanged and feed Call B an empty body under its label.
 */
async function hasDerivative(
  fs: FsAdapter,
  source: DiscoveredSource,
  alsoOwnedBy?: string,
): Promise<boolean> {
  const derivative = derivativePathFor(source.path, source.format);
  if (derivative === null) return true;
  if (!(await fs.exists(derivative))) return false;

  try {
    const { data } = parseFrontmatter(decodeUtf8(await fs.read(derivative)));
    const origin = data["derived-from"];
    return origin === source.path || (alsoOwnedBy !== undefined && origin === alsoOwnedBy);
  } catch {
    return false;
  }
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

/**
 * Characters that make a path impossible for Luka to record faithfully, with
 * the reason for the §6.1-style skip notice. `null` means the path is fine.
 *
 * §6.5 makes the citation block the persistent citer record and §4 writes a
 * source page's origin as `source: "[[<path>]]"`. Both are single-line forms,
 * so a path containing any line terminator cannot be read back — it would be
 * silently dropped from the record, which costs the user a source (and, once
 * the §6.6 cascade lands, the page). A backslash is equally unrepresentable:
 * vault paths are forward-slash only, so a literal one in a filename is
 * indistinguishable from a separator and would relocate the derivative.
 *
 * Skipping is the §6.1 idiom — named in a notice, never manifested, and so it
 * resurfaces every compile rather than failing silently or corrupting a record.
 */
function unrepresentable(path: string): string | null {
  // All four JavaScript line terminators: a regex `.` matches none of them,
  // which is exactly why a path carrying one fails to parse back out.
  if (/[\n\r\u2028\u2029]/.test(path)) return "path contains a line break";
  if (path.includes("\\")) return "path contains a backslash";
  // Both readers trim — `parseCitationBlock`'s entries and `source:`'s target —
  // so a segment padded with whitespace reads back as a different path. A file
  // needs an extension to be a source, but a repo directory does not, so
  // `raw/my repo ` is reachable. Under §6.6 a citer that no longer matches is
  // not just a lost line in the record; it can cost the page.
  if (path.split("/").some((segment) => segment !== segment.trim())) {
    return "path segment starts or ends with whitespace";
  }
  return null;
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
      const unwritable = unrepresentable(entry.path);
      if (unwritable !== null) {
        skipped.push({ path: entry.path, reason: unwritable });
        continue;
      }
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
