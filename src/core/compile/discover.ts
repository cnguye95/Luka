// Source discovery and the four change-detection rules (handoff.md §4, §6.2).
//
// Who is a source: everything under raw/ except raw/assets/ and except files
// carrying `derived-from`. A repo directory is one source and is never
// descended into. Identity is SHA-256 of content; timestamps are never used.
import type { FsAdapter } from "../adapters";
import { ownedBy, renameDerivativeAction, type RenameDerivativeAction } from "./cascade";
import { decodeUtf8, sha256Hex } from "../hash";
import { derivativePathFor, formatForPath } from "../normalize/index";
import { ASSETS_FOLDER } from "../normalize/image";
import { isRepoDirectory, repoContentHash, selectRepoFiles } from "../normalize/repo";
import { basename, comparePaths, dirname, extname, isUnder } from "../paths";
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
  /** The new path's format — what decides where its derivative belongs. */
  format: SourceFormat;
  /**
   * What compile owes this rename's derivative, decided here against the vault
   * as this run found it. Compile applies it rather than re-deriving it: by the
   * time it runs, its own earlier iterations have moved files about.
   */
  derivative: RenameDerivativeAction;
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

  // A skipped source is not a deleted one. §6.1 has an unsupported or
  // unrecordable file "surface again each compile rather than failing
  // silently", which means it is still sitting in the vault — so handing its
  // path to §6.6's cascade would delete the pages of a source that never went
  // away. This matters most when the skip rules themselves change: a path that
  // compiled cleanly yesterday must not be cascaded on today.
  // A skipped *folder* is never descended into, so every source beneath it is
  // absent from `present` too — and they are just as much still in the vault as
  // the folder is.
  const vanished = Object.keys(manifest)
    .filter(
      (path) =>
        !present.has(path) &&
        !skipped.some((entry) => path === entry.path || isUnder(path, entry.path)),
    )
    .sort();

  const { renamed, remainingAdded, remainingDeleted } = pairRenames(added, vanished, manifest);

  // A rename is always a rename: the manifest path and every wiki reference
  // follow the file. Reporting the old path as deleted instead would hand
  // §6.6's cascade a source that never went away, and a plain folder move —
  // which always leaves the derivative behind — would delete the pages citing
  // it.
  //
  // Whether it is *also* modified depends on the derivative. Compile can carry
  // one over, in place or by moving it, and §6.2 says a derivative persists
  // until its original changes — which a rename does not do. Only when there
  // is nothing usable to carry does the missing-derivative rule apply.
  // Sorted first so the decisions below, which depend on what earlier renames
  // in this run have claimed, do not vary with walk order.
  const renames: Rename[] = [];
  const claimedDerivatives = new Set<string>();

  for (const rename of [...renamed].sort((a, b) => comparePaths(a.to, b.to))) {
    const source = present.get(rename.to) as DiscoveredSource;
    let action = await renameDerivativeAction(fs, rename);

    // Two renames can want the same derivative location — `a.csv` and `b.html`
    // both moving to `q.*` land on `q.md`. Only the first can carry its file
    // there; the second has to re-extract, and deciding that here is what keeps
    // it in the worklist. Compile discovering it later could only skip it,
    // leaving a source manifested with no derivative of its own.
    const at = action.kind === "move" ? action.to : action.kind === "repoint" ? action.at : null;
    if (at !== null && claimedDerivatives.has(at)) action = { kind: "reprocess" };
    else if (at !== null) claimedDerivatives.add(at);

    renames.push({ ...rename, derivative: action });
    if (action.kind === "reprocess") modified.push(source);
  }

  return {
    added: remainingAdded.sort(byPath),
    modified: modified.sort(byPath),
    unchanged: unchanged.sort(byPath),
    deleted: remainingDeleted.sort(),
    // Already in the order the decisions above were taken; re-sorting with a
    // different comparator would let `discovery.renamed` disagree with them.
    renamed: renames,
    skipped: skipped.sort((a, b) => comparePaths(a.path, b.path)),
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
async function hasDerivative(fs: FsAdapter, source: DiscoveredSource): Promise<boolean> {
  const derivative = derivativePathFor(source.path, source.format);
  if (derivative === null) return true;
  return ownedBy(fs, derivative, source.path);
}

/** A rename before its derivative decision is taken. */
type PairedRename = Omit<Rename, "derivative">;

/**
 * Index of the vanished path that best explains an addition at `to`. Bucket
 * order is already deterministic, so the fallback is simply the first entry.
 */
function bestPairing(bucket: readonly string[], to: string): number {
  const sameName = bucket.findIndex((from) => basename(from) === basename(to));
  if (sameName !== -1) return sameName;
  const sameFolder = bucket.findIndex((from) => dirname(from) === dirname(to));
  return sameFolder === -1 ? 0 : sameFolder;
}

/**
 * Same hash gone from one path and appeared at another. Pairs are formed in
 * lexicographic order so the outcome does not depend on walk order.
 */
function pairRenames(
  added: readonly DiscoveredSource[],
  vanished: readonly string[],
  manifest: IngestManifest,
): { renamed: PairedRename[]; remainingAdded: DiscoveredSource[]; remainingDeleted: string[] } {
  const vanishedByHash = new Map<string, string[]>();
  for (const path of vanished) {
    const hash = manifest[path] as string;
    const bucket = vanishedByHash.get(hash);
    if (bucket) bucket.push(path);
    else vanishedByHash.set(hash, [path]);
  }

  const renamed: PairedRename[] = [];
  const remainingAdded: DiscoveredSource[] = [];
  const claimed = new Set<string>();

  for (const source of [...added].sort(byPath)) {
    const bucket = vanishedByHash.get(source.hash);
    if (bucket === undefined || bucket.length === 0) {
      remainingAdded.push(source);
      continue;
    }
    // Two byte-identical sources make the pairing ambiguous, and §4's identity
    // rule offers no tiebreak — but the vault usually does. Prefer the vanished
    // path that shares this one's basename, then its directory, before falling
    // back to the first in code-point order: a user who deletes one copy and
    // moves the other should not have the survivor inherit the wrong history.
    const at = bestPairing(bucket, source.path);
    const from = bucket.splice(at, 1)[0] as string;
    claimed.add(from);
    renamed.push({ from, to: source.path, hash: source.hash, format: source.format });
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
  // Both readers trim the recorded value as a whole — `parseCitationBlock`'s
  // entry and `source:`'s target — so it is padding at the very ends of the
  // path that fails to round-trip, not whitespace inside it. Every source path
  // starts with `raw/`, which leaves a trailing-space basename as the reachable
  // case: a file needs an extension to be a source, but a repo directory does
  // not, so `raw/my repo ` is legal. Under §6.6 a citer that no longer matches
  // is not just a lost line in the record; it can cost the page.
  if (path !== path.trim()) return "path starts or ends with whitespace";
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
  // Code-point order, never `localeCompare`: this decides which addition pairs
  // with which vanished path when several share a hash, so a Turkish or
  // Estonian collation must not produce a different rename from an English one.
  return comparePaths(a.path, b.path);
}
