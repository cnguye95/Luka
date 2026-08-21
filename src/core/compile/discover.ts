// Source discovery and the four change-detection rules (handoff.md §4, §6.2).
//
// Who is a source: everything under raw/ except raw/assets/ and except files
// carrying `derived-from`. A repo directory is one source and is never
// descended into. Identity is SHA-256 of content; timestamps are never used.
import type { FsAdapter } from "../adapters";
import { decodeUtf8, sha256Hex } from "../hash";
import { derivativeOrigin, derivativePathFor, formatForPath } from "../normalize/index";
import { ASSETS_FOLDER } from "../normalize/image";
import { isRepoDirectory, repoContentHash, selectRepoFiles } from "../normalize/repo";
import { basename, comparePaths, dirname, extname, isUnder } from "../paths";
import type { IngestManifest, ManifestEntry, SourceFormat } from "../types";
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

/**
 * Same bytes, gone from one path and present at another. Identity only: what
 * this run owes the derivative is decided later, in one pass, by `carryRenames`
 * (invariant V) — discovery answers "is this the same source", not "where is
 * its markdown".
 *
 * `source` is the file at its new path, carried whole so a rename that has to
 * re-extract can join the normalize worklist without anything being inferred
 * back out of the path. `source.path` is the new path; `from` is the old one.
 */
export interface Rename {
  from: string;
  source: DiscoveredSource;
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
    } else if (recorded.hash !== source.hash || !(await hasDerivative(fs, source, recorded))) {
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
  // A rename is never *also* modified here. §6.2's missing-derivative rule is
  // about a source whose markdown is gone; a renamed source's markdown is a
  // question about where the carry can put it, which `carryRenames` answers
  // against the vault at the moment it acts. A rename it cannot complete
  // re-enters the worklist there.
  return {
    added: remainingAdded.sort(byPath),
    modified: modified.sort(byPath),
    unchanged: unchanged.sort(byPath),
    deleted: remainingDeleted.sort(),
    // Ordered by the new path, which is the order `carryRenames` acts in, so
    // two renames competing for one derivative location resolve the same way
    // on every host.
    renamed: [...renamed].sort((a, b) => comparePaths(a.source.path, b.source.path)),
    skipped: skipped.sort((a, b) => comparePaths(a.path, b.path)),
  };
}

/**
 * §6.2's missing-derivative test. The entry says which file, so no candidate is
 * guessed from the stem — that guess is what invariant II removes, and with it
 * the whole class of defects where a neighbour sharing a stem was mistaken for
 * a source's markdown.
 *
 * What the entry cannot say is whether that file is *still* this source's. A
 * user can overwrite a derivative in place, and then a file stands at the
 * recorded path that is not markdown Luka wrote — so the pointer is checked
 * against the file, exactly as it is before any destructive write or before
 * serving the file as a source's body. Locating is what the entry is for;
 * `derived-from` remains a guard and nothing else.
 *
 * The cost is one read and one YAML parse per unchanged converting source per
 * compile, which M2d weighed and accepted for the same reason: reads are not
 * writes, and an unchanged vault still performs literally zero writes.
 *
 * A converting source carrying no pointer at all is an entry written before
 * ownership was recorded. Its derivative cannot be located, so the
 * missing-derivative rule applies and it reprocesses once, which records one.
 */
async function hasDerivative(
  fs: FsAdapter,
  source: DiscoveredSource,
  entry: ManifestEntry,
): Promise<boolean> {
  // A passthrough source is its own readable markdown and owes no derivative.
  if (derivativePathFor(source.path, source.format) === null) return true;
  if (entry.derivative === undefined) return false;
  try {
    // Also settles the case of a directory built over the derivative: a folder
    // names no origin, so it is not this source's markdown either.
    return (await derivativeOrigin(fs, entry.derivative)) === source.path;
  } catch {
    // The file could not be read at all. That answers neither "still ours" nor
    // "not ours", and the two costs are wildly different: treating it as absent
    // re-extracts over whatever is there — silently, since nothing failed — on
    // an IO blip. The entry stands until something actually contradicts it.
    return true;
  }
}

/**
 * Index of the vanished path that best explains an addition at `to`.
 *
 * Scored rather than ordered by signal, because neither signal dominates.
 * Preferring the basename outright cross-pairs two siblings that swapped names
 * within their own folders; preferring the folder outright hands a moved file
 * to an unrelated neighbour. Staying in the same folder is the strongest
 * evidence, moving deeper into it the next, and keeping the name the next —
 * and ties fall back to the bucket's own deterministic order.
 */
function bestPairing(bucket: readonly string[], to: string): number {
  let best = 0;
  let bestScore = -1;
  for (const [at, from] of bucket.entries()) {
    let score = 0;
    if (dirname(from) === dirname(to)) score += 2;
    else if (isUnder(dirname(to), dirname(from))) score += 1;
    if (basename(from) === basename(to)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = at;
    }
  }
  return best;
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
    // Bucketed by hash: `CASCADE_PENDING` is not one, so a pending entry can
    // never pair as a rename with a real file.
    const hash = (manifest[path] as ManifestEntry).hash;
    const bucket = vanishedByHash.get(hash);
    if (bucket) bucket.push(path);
    else vanishedByHash.set(hash, [path]);
  }

  const renamed: Rename[] = [];
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
    renamed.push({ from, source });
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
