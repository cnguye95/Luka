// The ingest manifest: vault-relative source path -> SHA-256 of its content
// (handoff.md §3, §6.2). Written only for sources that completed successfully
// (invariant 3); a missing manifest is a first run, never an error.
import type { FsAdapter } from "./adapters";
import { decodeUtf8 } from "./hash";
import { dirname } from "./paths";
import type { IngestManifest } from "./types";

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
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export async function saveManifest(
  fs: FsAdapter,
  path: string,
  manifest: IngestManifest,
): Promise<void> {
  const sorted: IngestManifest = {};
  for (const key of Object.keys(manifest).sort()) sorted[key] = manifest[key] as string;

  const parent = dirname(path);
  if (parent !== "") await fs.mkdir(parent);
  await fs.write(path, `${JSON.stringify(sorted, null, 2)}\n`);
}
