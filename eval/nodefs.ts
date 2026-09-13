import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DirEntry, FileStat, FsAdapter } from "../src/core/adapters";
import { normalizePath } from "../src/core/paths";

/**
 * FsAdapter over node:fs, rooted at a vault directory. It lives here — "eval and
 * tests implement them over node:fs and fetch" — and it also proves src/core
 * runs with no Obsidian at all.
 */
export class NodeFs implements FsAdapter {
  writes = 0;

  constructor(private readonly root: string) {}

  resetCounters(): void {
    this.writes = 0;
  }

  private absolute(vaultPath: string): string {
    const segments = normalizePath(vaultPath).split("/").filter(Boolean);
    return path.join(this.root, ...segments);
  }

  async read(vaultPath: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.absolute(vaultPath)));
  }

  async write(vaultPath: string, data: string | Uint8Array): Promise<void> {
    this.writes += 1;
    const target = this.absolute(vaultPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof data === "string" ? Buffer.from(data, "utf8") : data);
  }

  async list(vaultPath: string): Promise<DirEntry[]> {
    const base = normalizePath(vaultPath);
    let entries;
    try {
      entries = await readdir(this.absolute(vaultPath), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .map((entry): DirEntry => ({
        path: base === "" ? entry.name : `${base}/${entry.name}`,
        kind: entry.isDirectory() ? "folder" : "file",
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async stat(vaultPath: string): Promise<FileStat | null> {
    try {
      const stats = await stat(this.absolute(vaultPath));
      return { size: stats.size, kind: stats.isDirectory() ? "folder" : "file" };
    } catch {
      return null;
    }
  }

  async move(from: string, to: string): Promise<void> {
    const target = this.absolute(to);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(this.absolute(from), target);
  }

  async exists(vaultPath: string): Promise<boolean> {
    try {
      await access(this.absolute(vaultPath), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(vaultPath: string): Promise<void> {
    await mkdir(this.absolute(vaultPath), { recursive: true });
  }

  async delete(vaultPath: string): Promise<void> {
    await rm(this.absolute(vaultPath), { recursive: true, force: true });
  }
}
