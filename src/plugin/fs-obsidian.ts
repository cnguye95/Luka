import type { DataAdapter } from "obsidian";
import type { DirEntry, FileStat, FsAdapter } from "../core/adapters";
import { dirname, normalizePath } from "../core/paths";

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
    ].sort((a, b) => a.path.localeCompare(b.path));
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
      if (!(await this.adapter.exists(current))) await this.adapter.mkdir(current);
    }
  }

  async delete(path: string): Promise<void> {
    await this.adapter.remove(normalizePath(path));
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
