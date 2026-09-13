// The ingest manifest: vault-relative source path -> what this source's last
// successful ingest produced. Written only for sources
// that completed successfully (invariant 3); a missing manifest is a first run,
// never an error.
//
// The obvious shape is "path -> SHA-256 content hash". The entry is an
// object instead, because the hash alone cannot say *which* file is this
// source's derivative — and deriving that from the filename every compile is
// what made the first rename subsystem unsafe (design_decisions.md, decision
// 6). Ownership is recorded here so nothing downstream has to infer it.
import type { FsAdapter } from "./adapters";
import { decodeUtf8 } from "./hash";
import { comparePaths, dirname } from "./paths";
import type { IngestManifest, ManifestEntry } from "./types";
import { readableMarkdown } from "./readable";

/**
 * The hash recorded for a source that left the vault but whose cascade could
 * not be completed, so the four rules see the path leave again next compile
 * and the cascade retries.
 *
 * Deliberately not a SHA-256. Sources are identified by content hash, and a
 * restored real hash would sit in the manifest for as many runs as the failure
 * lasts, waiting to pair as a rename against any unrelated file that happens to
 * share those bytes. Nothing can hash to this, so the entry can only ever be
 * read as "still gone, still owed a cascade".
 *
 * A pending entry keeps its `derivative` pointer: that is the file the retry
 * still has to sweep.
 */
export const CASCADE_PENDING = "cascade-pending";

export function isPending(entry: ManifestEntry): boolean {
  return entry.hash === CASCADE_PENDING;
}

/**
 * Every manifest source's readable markdown (the source itself if `.md`/`.txt`,
 * else its derivative) — the whole point of recording the
 * derivative. `null` for a source that is not readable: one whose cascade is
 * still pending, and so is not in the vault at all.
 *
 * This is the path the entry names, not a promise that a file stands there.
 * A caller that is about to read it must still check — `stat().kind === "file"`
 * — because a user can move, delete, or build a directory over a derivative
 * between two compiles.
 */
export function readablePathOf(path: string, entry: ManifestEntry): string | null {
  return readableMarkdown(path, entry.derivative, isPending(entry));
}

export async function loadManifest(fs: FsAdapter, path: string): Promise<IngestManifest> {
  if (!(await fs.exists(path))) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(await fs.read(path)));
  } catch {
    // A corrupt manifest self-heals as a first run: every source reprocesses,
    // which is idempotent, rather than blocking compile outright.
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: IngestManifest = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // `out[key] = …` with a key of `__proto__` reparents `out` instead of
    // adding to it: the entry vanishes from `Object.keys` and the object starts
    // inheriting whatever the file supplied. Every key here is meant to be a
    // vault path, and no vault path is `__proto__`, so it is dropped like any
    // other unreadable entry — at the boundary, because the same assignment
    // shape appears in `saveManifest` and at five sites building the next
    // manifest, and none of them can be handed a key that never gets in.
    if (key === "__proto__") continue;
    const entry = toEntry(value);
    if (entry !== null) out[key] = entry;
  }
  return out;
}

/**
 * A bare string is a manifest written before ownership was recorded: it is a
 * hash and nothing more. Reading it costs a converting source one re-extraction,
 * which restores the pointer; a passthrough source has no derivative to record
 * and is unaffected. An entry that is neither shape is dropped, as any
 * unreadable value always has been.
 */
function toEntry(value: unknown): ManifestEntry | null {
  if (typeof value === "string") return { hash: value };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const hash = record["hash"];
  if (typeof hash !== "string") return null;

  const derivative = record["derivative"];
  return typeof derivative === "string" ? { hash, derivative } : { hash };
}

export async function saveManifest(
  fs: FsAdapter,
  path: string,
  manifest: IngestManifest,
): Promise<void> {
  // Code-point order, like every other path ordering in the codebase, so the
  // file's bytes do not depend on the host's locale.
  const sorted: Record<string, ManifestEntry> = {};
  for (const key of Object.keys(manifest).sort(comparePaths)) {
    const entry = manifest[key] as ManifestEntry;
    // Written key by key rather than spread, so the serialized key order is
    // fixed here rather than inherited from however the entry was built.
    sorted[key] =
      entry.derivative === undefined
        ? { hash: entry.hash }
        : { hash: entry.hash, derivative: entry.derivative };
  }

  const parent = dirname(path);
  if (parent !== "") await fs.mkdir(parent);
  await fs.write(path, `${JSON.stringify(sorted, null, 2)}\n`);
}

/** Structural, never by reference: entries are rebuilt each run (invariant I). */
export function isSameManifest(a: IngestManifest, b: IngestManifest): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    if (!Object.hasOwn(b, key)) return false;
    const left = a[key] as ManifestEntry;
    const right = b[key] as ManifestEntry;
    return left.hash === right.hash && left.derivative === right.derivative;
  });
}
