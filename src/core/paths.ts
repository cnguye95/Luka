// Vault-relative path helpers. Forward slashes only; `node:path` is unavailable
// to src/core, which must run unchanged in the Obsidian renderer.

/** Collapses separators, drops `.` segments, resolves `..`, strips leading and trailing slashes. */
export function normalizePath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join("/"));
}

/** `""` for a path with no parent. */
export function dirname(path: string): string {
  const norm = normalizePath(path);
  const at = norm.lastIndexOf("/");
  return at === -1 ? "" : norm.slice(0, at);
}

export function basename(path: string): string {
  const norm = normalizePath(path);
  const at = norm.lastIndexOf("/");
  return at === -1 ? norm : norm.slice(at + 1);
}

/** Lowercased and dot-prefixed (`.md`); `""` when there is no extension. */
export function extname(path: string): string {
  const name = basename(path);
  const at = name.lastIndexOf(".");
  if (at <= 0) return "";
  return name.slice(at).toLowerCase();
}

/** Basename without its extension. */
export function stem(path: string): string {
  const name = basename(path);
  const ext = extname(path);
  return ext === "" ? name : name.slice(0, name.length - ext.length);
}

/** True when `path` is `ancestor` itself or sits underneath it. */
export function isUnder(path: string, ancestor: string): boolean {
  const p = normalizePath(path);
  const a = normalizePath(ancestor);
  if (a === "") return true;
  return p === a || p.startsWith(`${a}/`);
}

/** handoff.md invariant 8: a leading `_` marks infrastructure. */
export function isInfrastructure(path: string): boolean {
  return basename(path).startsWith("_");
}
