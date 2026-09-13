import type { DataAdapter } from "obsidian";
import type { DirEntry, FileStat, FsAdapter } from "../core/adapters";
import { comparePaths, dirname, normalizePath } from "../core/paths";

/** FsAdapter over Obsidian's vault adapter. Paths in, paths out, all vault-relative. */
export class ObsidianFs implements FsAdapter {
  constructor(private readonly adapter: DataAdapter) {}

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.adapter.readBinary(normalizePath(path)));
  }

  async write(path: string, data: string | Uint8Array): Promise<void> {
    const target = normalizePath(path);
    await this.mkdir(dirname(target));
    if (typeof data === "string") await this.adapter.write(target, data);
    else await this.adapter.writeBinary(target, toArrayBuffer(data));
  }

  async list(path: string): Promise<DirEntry[]> {
    const directory = normalizePath(path);
    if (!(await this.adapter.exists(directory))) return [];
    const listed = await this.adapter.list(directory);
    return [
      ...listed.files.map((file): DirEntry => ({ path: normalizePath(file), kind: "file" })),
      ...listed.folders.map((folder): DirEntry => ({ path: normalizePath(folder), kind: "folder" })),
      // core's rule, not a second one here: `localeCompare` orders by the
      // host's locale, so `_x.md a.md A.md` came back in an order three
      // consumers had to defensively re-sort.
    ].sort((a, b) => comparePaths(a.path, b.path));
  }

  async stat(path: string): Promise<FileStat | null> {
    const stat = await this.adapter.stat(normalizePath(path));
    return stat === null ? null : { size: stat.size, kind: stat.type };
  }

  async move(from: string, to: string): Promise<void> {
    const target = normalizePath(to);
    await this.mkdir(dirname(target));
    await this.adapter.rename(normalizePath(from), target);
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(normalizePath(path));
  }

  async mkdir(path: string): Promise<void> {
    const target = normalizePath(path);
    if (target === "") return;
    // Obsidian's mkdir does not promise to create intermediate folders.
    let current = "";
    for (const segment of target.split("/")) {
      current = current === "" ? segment : `${current}/${segment}`;
      // `stat`, not `exists`: a *file* standing where a folder belongs is
      // "exists", so mkdir was skipped and the write below failed with ENOENT
      // instead of naming the real obstruction.
      if ((await this.adapter.stat(current))?.type === "folder") continue;
      try {
        await this.adapter.mkdir(current);
      } catch (error) {
        // Check-then-act, and images are fetched four at once — on the first
        // compile of a document with two kept remote images every in-flight
        // call sees raw/assets absent. Losing that race is success; the throw
        // used to escape to normalizeSource and fail the whole source, where
        // the rule asks only that the link be left and marked.
        if ((await this.adapter.stat(current))?.type !== "folder") throw error;
      }
    }
  }

  async delete(path: string): Promise<void> {
    const target = normalizePath(path);
    // Obsidian's own recovery path, never a permanent unlink. What comes
    // through here is a cascade-doomed page — the modal calls them pages that
    // *may* be deleted, so the user approves a superset and cannot know which
    // went — and derivatives under `raw/`, including one a user hand-repaired,
    // which is the sanctioned repair. `remove()` put all of that
    // beyond recovery while `trashSystem`/`trashLocal` sat on the same adapter
    // unused. This is not the backup rotation the non-goals forbid; it is the
    // platform's own default.
    // `trashSystem` is documented to answer false where the platform has no
    // usable trash, but a sandboxed host can reject instead — and a rejection
    // that skipped the fallback would leave the file in place with no second
    // attempt. Either way the answer is "try the vault's own trash".
    try {
      if (await this.adapter.trashSystem(target)) return;
    } catch {
      // Fall through: the vault's own .trash is the answer either way.
    }
    await this.adapter.trashLocal(target);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
