// Repository sources (handoff.md §6.4).
//
// A directory under raw/ is a repo iff it holds `.git/` or a `.luka-repo`
// marker; its files are never individual sources. Identity is the directory
// path and the hash is taken over the ordered selection, so the four rules in
// §6.2 apply to repos unchanged.
import type { FsAdapter } from "../adapters";
import { concatBytes, decodeUtf8, sha256Hex, utf8 } from "../hash";
import { repoFileOmitted } from "../markers";
import { basename, comparePaths, dirname, extname, isUnder, joinPath } from "../paths";

export const REPO_MARKER_FILE = ".luka-repo";

// handoff.md §17 marks the caps fixed.
const MAX_FILE_BYTES = 100 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

const EXTENSION_WHITELIST = new Set([
  ".md",
  ".ts",
  ".js",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".rb",
  ".sh",
  ".toml",
  ".yaml",
  ".json",
]);

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "out", "vendor"]);

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "cargo.lock",
  "poetry.lock",
  "gemfile.lock",
  "composer.lock",
]);

export interface RepoFile {
  /** Vault path. */
  path: string;
  /** Path relative to the repo root — what the `## ` header and the hash use. */
  relative: string;
  bytes: Uint8Array;
}

export async function isRepoDirectory(fs: FsAdapter, path: string): Promise<boolean> {
  if (await fs.exists(joinPath(path, ".git"))) return true;
  return fs.exists(joinPath(path, REPO_MARKER_FILE));
}

/**
 * The included files in selection order: `README*` at the repo root first, then
 * everything under `docs/`, then the rest — each group breadth-first by path.
 */
export async function selectRepoFiles(fs: FsAdapter, root: string): Promise<RepoFile[]> {
  const all = (await walkBreadthFirst(fs, root)).filter((path) => isIncluded(path, root));
  const docsRoot = joinPath(root, "docs");

  const readme: string[] = [];
  const docs: string[] = [];
  const rest: string[] = [];
  for (const path of all) {
    if (isRootReadme(path, root)) readme.push(path);
    else if (isUnder(path, docsRoot)) docs.push(path);
    else rest.push(path);
  }

  const ordered = [...readme, ...docs, ...rest];
  const files: RepoFile[] = [];
  for (const path of ordered) {
    files.push({
      path,
      relative: path.slice(root.length + 1),
      bytes: await fs.read(path),
    });
  }
  return files;
}

/**
 * SHA-256 over the ordered concatenation of (relative path + file bytes).
 * Size caps are a rendering concern and deliberately do not affect identity.
 */
export async function repoContentHash(files: readonly RepoFile[]): Promise<string> {
  const chunks: Uint8Array[] = [];
  for (const file of files) {
    chunks.push(utf8(file.relative), file.bytes);
  }
  return sha256Hex(concatBytes(chunks));
}

export function repoToMarkdown(root: string, files: readonly RepoFile[]): string {
  const sections: string[] = [`# ${basename(root)}`, ""];
  let total = 0;

  for (const file of files) {
    sections.push(`## ${file.relative}`, "");
    if (file.bytes.length > MAX_FILE_BYTES) {
      sections.push(repoFileOmitted(file.relative, "file over 100KB"), "");
      continue;
    }
    if (total + file.bytes.length > MAX_TOTAL_BYTES) {
      sections.push(repoFileOmitted(file.relative, "repo total over 1MB"), "");
      continue;
    }
    total += file.bytes.length;
    const content = decodeUtf8(file.bytes).replace(/\n+$/, "");
    const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
    sections.push(`${fence}${languageFor(file.relative)}`, content, fence, "");
  }

  return sections.join("\n");
}

async function walkBreadthFirst(fs: FsAdapter, root: string): Promise<string[]> {
  const files: string[] = [];
  let level = [root];
  while (level.length > 0) {
    const next: string[] = [];
    for (const directory of level) {
      const entries = (await fs.list(directory)).sort((a, b) => comparePaths(a.path, b.path));
      for (const entry of entries) {
        if (entry.kind === "folder") {
          if (!EXCLUDED_DIRECTORIES.has(basename(entry.path))) next.push(entry.path);
        } else {
          files.push(entry.path);
        }
      }
    }
    level = next;
  }
  return files;
}

function isRootReadme(path: string, root: string): boolean {
  return dirname(path) === root && /^readme/i.test(basename(path));
}

function isIncluded(path: string, root: string): boolean {
  const name = basename(path);
  if (name === REPO_MARKER_FILE) return false;
  if (LOCKFILES.has(name.toLowerCase())) return false;
  if (isRootReadme(path, root)) return true;
  return EXTENSION_WHITELIST.has(extname(path));
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".md": "markdown",
  ".ts": "ts",
  ".js": "js",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".rb": "ruby",
  ".sh": "bash",
  ".toml": "toml",
  ".yaml": "yaml",
  ".json": "json",
};

function languageFor(relative: string): string {
  return LANGUAGE_BY_EXTENSION[extname(relative)] ?? "";
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}
