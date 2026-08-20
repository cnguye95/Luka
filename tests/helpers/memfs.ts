import type { DirEntry, FileStat, FsAdapter } from "../../src/core/adapters";
import { decodeUtf8, utf8 } from "../../src/core/hash";
import { dirname, normalizePath } from "../../src/core/paths";

/** In-memory FsAdapter that counts mutations, so tests can assert "zero work". */
export class MemFs implements FsAdapter {
  readonly files = new Map<string, Uint8Array>();
  private readonly folders = new Set<string>();

  writes = 0;
  reads = 0;
  moves = 0;
  deletes = 0;

  constructor(seed: Record<string, string | Uint8Array> = {}) {
    for (const [path, data] of Object.entries(seed)) {
      this.files.set(normalizePath(path), typeof data === "string" ? utf8(data) : data);
    }
  }

  resetCounters(): void {
    this.writes = 0;
    this.reads = 0;
    this.moves = 0;
    this.deletes = 0;
  }

  /** Test convenience — decoded contents, throws when absent. */
  text(path: string): string {
    const bytes = this.files.get(normalizePath(path));
    if (!bytes) throw new Error(`no such file: ${path}`);
    return decodeUtf8(bytes);
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  private impliedFolders(): Set<string> {
    const all = new Set(this.folders);
    for (const path of this.files.keys()) {
      let parent = dirname(path);
      while (parent !== "") {
        all.add(parent);
        parent = dirname(parent);
      }
    }
    return all;
  }

  async read(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(normalizePath(path));
    if (!bytes) throw new Error(`ENOENT: ${path}`);
    this.reads += 1;
    return bytes;
  }

  async write(path: string, data: string | Uint8Array): Promise<void> {
    this.writes += 1;
    this.files.set(normalizePath(path), typeof data === "string" ? utf8(data) : data);
  }

  async list(path: string): Promise<DirEntry[]> {
    const dir = normalizePath(path);
    const prefix = dir === "" ? "" : `${dir}/`;
    const entries = new Map<string, DirEntry>();

    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (rest === "") continue;
      const segment = rest.split("/")[0] as string;
      const full = prefix + segment;
      entries.set(full, { path: full, kind: rest.includes("/") ? "folder" : "file" });
    }
    for (const folder of this.impliedFolders()) {
      if (!folder.startsWith(prefix)) continue;
      const rest = folder.slice(prefix.length);
      if (rest === "" || rest.includes("/")) continue;
      entries.set(folder, { path: folder, kind: "folder" });
    }
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async stat(path: string): Promise<FileStat | null> {
    const norm = normalizePath(path);
    const bytes = this.files.get(norm);
    if (bytes) return { size: bytes.length, kind: "file" };
    if (this.impliedFolders().has(norm)) return { size: 0, kind: "folder" };
    return null;
  }

  async move(from: string, to: string): Promise<void> {
    const norm = normalizePath(from);
    const bytes = this.files.get(norm);
    if (!bytes) throw new Error(`ENOENT: ${from}`);
    this.moves += 1;
    this.files.delete(norm);
    this.files.set(normalizePath(to), bytes);
  }

  async exists(path: string): Promise<boolean> {
    const norm = normalizePath(path);
    return this.files.has(norm) || this.impliedFolders().has(norm);
  }

  async mkdir(path: string): Promise<void> {
    const norm = normalizePath(path);
    if (norm !== "") this.folders.add(norm);
  }

  async delete(path: string): Promise<void> {
    const norm = normalizePath(path);
    this.deletes += 1;
    this.files.delete(norm);
    this.folders.delete(norm);
  }
}
