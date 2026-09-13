// Repository sources.
//
// A directory under raw/ is a repo iff it holds `.git/` or a `.luka-repo`
// marker; its files are never individual sources. Identity is the directory
// path and the hash is taken over the ordered selection, so the four
// change-detection rules apply to repos unchanged.
import type { FsAdapter } from "../adapters";
import { concatBytes, decodeUtf8, sha256Hex, utf8 } from "../hash";
import { repoFileOmitted } from "../markers";
import { basename, comparePaths, dirname, extname, isUnder, joinPath } from "../paths";

export const REPO_MARKER_FILE = ".luka-repo";

// The caps are fixed, not settings.
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
  /**
   * SHA-256 over this file's framed (relative path, content) pair. Always
   * present, and always over the *whole* content, so identity ignores the size
   * caps exactly as it did when the hash concatenated everything.
   */
  digest: string;
  /** The file's size in bytes, kept even when the content was let go. */
  size: number;
  /**
   * The content — `null` once this file is known to be unrenderable, so a repo
   * of large files is not held in memory to produce a derivative that will
   * contain only omission markers.
   */
  bytes: Uint8Array | null;
  /** Why the content will not be rendered, if it will not be. */
  omitted: string | null;
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
  let retained = 0;

  for (const path of ordered) {
    const relative = path.slice(root.length + 1);
    const bytes = await fs.read(path);
    const digest = await fileDigest(relative, bytes);

    // The caps are decided here rather than at render, so content that cannot
    // be rendered is released as soon as its digest is taken. Identity is
    // unaffected: the digest already covers the whole file.
    let omitted: string | null = null;
    if (bytes.length > MAX_FILE_BYTES) omitted = "file over 100KB";
    else if (retained + bytes.length > MAX_TOTAL_BYTES) omitted = "repo total over 1MB";
    else retained += bytes.length;

    files.push({
      path,
      relative,
      digest,
      size: bytes.length,
      bytes: omitted === null ? bytes : null,
      omitted,
    });
  }
  return files;
}

/**
 * A file's contribution to repo identity: its path and its content, each
 * length-prefixed.
 *
 * The framing is the point. Concatenating the path and the bytes with nothing
 * between them made a file boundary indistinguishable from content that happens
 * to spell the next file's path, so two structurally different repos could hash
 * identically — and under the four rules a repo mutating between those
 * shapes read as unchanged and was never reprocessed.
 */
async function fileDigest(relative: string, bytes: Uint8Array): Promise<string> {
  const header = utf8(`${relative.length}:${relative}:${bytes.length}:`);
  return sha256Hex(concatBytes([header, bytes]));
}

/**
 * SHA-256 over the ordered per-file digests. Size caps are a rendering concern
 * and deliberately do not affect identity — each digest covers its file's whole
 * content, including content too large to render.
 *
 * Hashing digests rather than the concatenated content keeps this bounded: the
 * previous form built one contiguous copy of every selected byte, doubling the
 * peak for a repo whose files are all going to be omitted anyway.
 */
export async function repoContentHash(files: readonly RepoFile[]): Promise<string> {
  return sha256Hex(utf8(files.map((file) => file.digest).join("\n")));
}

export function repoToMarkdown(root: string, files: readonly RepoFile[]): string {
  const sections: string[] = [`# ${basename(root)}`, ""];

  for (const file of files) {
    sections.push(`## ${file.relative}`, "");
    if (file.omitted !== null || file.bytes === null) {
      sections.push(repoFileOmitted(file.relative, file.omitted ?? "content not retained"), "");
      continue;
    }
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
