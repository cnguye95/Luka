// The retrieval graph (handoff.md §7.1).
//
// "Nodes: every file under `wiki/` (minus `_`-prefixed) plus every manifest
// source's readable markdown (the source itself if `.md`/`.txt`, else its
// derivative). A raw node's display title is its basename. Edges: every
// `[[wikilink]]` occurring anywhere in a node's file — body, citation block,
// frontmatter `source:` — resolved to a node; links that resolve to no node
// contribute nothing. Undirected, uniform weight, deduplicated per pair;
// `_` files contribute nothing."
//
// Built in memory, never cached to disk — §7.1 says so outright, and a cache
// would be a fourth thing that can disagree with the vault.
import type { FsAdapter } from "../adapters";
import { loadManifest, readablePathOf } from "../manifest";
import { basename, comparePaths } from "../paths";
import type { GraphEdge, GraphNode, GraphSnapshot } from "../types";
import { decodeUtf8 } from "../hash";
import { linkTargets } from "../compile/links";
import { handleOf, loadPageTable } from "../compile/pagetable";

export interface BuildGraphInput {
  fs: FsAdapter;
  manifestPath: string;
}

/**
 * One pass over the vault: wiki pages from the page table, raw sources from the
 * manifest, then edges from every link either kind of file carries.
 *
 * The whole file is scanned for links, not just the body — §7.1 names three
 * surfaces and frontmatter `source:` is one of them, so stripping frontmatter
 * first would silently drop every source page's edge to its own raw file.
 */
export async function buildGraph(input: BuildGraphInput): Promise<GraphSnapshot> {
  const { fs, manifestPath } = input;
  const pages = await loadPageTable(fs);
  const manifest = await loadManifest(fs, manifestPath);

  const nodes = new Map<string, GraphNode>();
  // Handle → node path. One node can be reachable by several names: a wiki page
  // by its title and each alias, a raw source by both its manifest path and the
  // readable markdown that stands in for it. Raw sources claim first — see the
  // page-name loop below for why.
  const byHandle = new Map<string, string>();

  for (const page of pages) {
    nodes.set(page.path, {
      path: page.path,
      title: page.title,
      kind: page.kind,
      degree: 0,
      summary: page.summary,
    });
  }

  for (const sourcePath of Object.keys(manifest).sort(comparePaths)) {
    const entry = manifest[sourcePath];
    if (entry === undefined) continue;
    // `null` is a source whose cascade is still pending: it is not in the vault,
    // so it is not a node (§7.1's node set is files that exist).
    const readable = readablePathOf(sourcePath, entry);
    if (readable === null) continue;
    // A wiki page never loses to a raw node for the same path, though the two
    // folders make that unreachable today.
    if (nodes.has(readable)) continue;
    nodes.set(readable, {
      path: readable,
      title: basename(readable),
      kind: "raw",
      degree: 0,
      // A raw source is a file, not a §4 page: there is no frontmatter to read a
      // summary from, and inventing one from the body would be a model call the
      // pane is not allowed to make.
      summary: "",
    });
    // §4 writes links into sources as full paths, and the path a citation block
    // or a `source:` key names is the *manifest* path — the PDF, not the
    // markdown extracted from it. Both names have to reach the one node, or a
    // source page has no edge to the very file it describes.
    claim(byHandle, readable, readable);
    claim(byHandle, sourcePath, readable);
  }

  // Page names last. Call A writes aliases from the body alone and is asked for
  // "obvious variants", so a dataset's descriptor page comes back aliased with
  // the dataset's own path — and §4 makes every citation block and `source:`
  // key name exactly that path. Had the page claimed first, each of those
  // links would be an edge to the descriptor and the raw node would sit at
  // degree 0, or for a passthrough source lose its every name. The manifest is
  // the authority on what a `raw/` path means; an alias that loses here costs
  // the page nothing it is owed. Titles cannot collide: `sanitizeTitle` strips
  // the `/` every source path carries.
  for (const page of pages) {
    claim(byHandle, page.title, page.path);
    for (const alias of page.aliases) claim(byHandle, alias, page.path);
  }

  const pairs = new Set<string>();
  const edges: GraphEdge[] = [];

  for (const path of [...nodes.keys()].sort(comparePaths)) {
    let text: string;
    try {
      text = decodeUtf8(await fs.read(path));
    } catch {
      // A node whose file cannot be read contributes no edges. It stays a node:
      // the page table and the manifest both already said it is one, and
      // dropping it here would make the node set depend on a transient read.
      continue;
    }

    for (const target of linkTargets(text)) {
      const other = resolve(byHandle, target);
      // §7.1: "links that resolve to no node contribute nothing."
      if (other === undefined || other === path) continue;
      // NUL as the separator, written as an escape: a literal one makes git
      // classify the whole file as binary, so no change to it could ever be
      // reviewed as a diff. (The M1/M2 campaign found the same thing in a test
      // file; this reintroduced it in new code.)
      const key = path < other ? `${path}\u0000${other}` : `${other}\u0000${path}`;
      if (pairs.has(key)) continue;
      pairs.add(key);
      edges.push(path < other ? { a: path, b: other } : { a: other, b: path });
    }
  }

  for (const edge of edges) {
    bump(nodes, edge.a);
    bump(nodes, edge.b);
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => comparePaths(a.path, b.path)),
    edges: edges.sort((a, b) => comparePaths(a.a, b.a) || comparePaths(a.b, b.b)),
  };
}

/** First claimant keeps a handle, so the table does not depend on scan order. */
function claim(byHandle: Map<string, string>, name: string, path: string): void {
  const key = handleOf(name);
  if (key === "" || byHandle.has(key)) return;
  byHandle.set(key, path);
}

/**
 * A link target resolved to a node path.
 *
 * Heading and block references address a place inside a page rather than a
 * page, exactly as `resolveLinks` treats them, so they resolve to nothing —
 * an edge drawn from `[[Page#Section]]` would claim a citation the vault does
 * not contain.
 */
function resolve(byHandle: ReadonlyMap<string, string>, target: string): string | undefined {
  if (target.includes("#") || target.includes("^")) return undefined;
  return byHandle.get(handleOf(target));
}

function bump(nodes: Map<string, GraphNode>, path: string): void {
  const node = nodes.get(path);
  if (node !== undefined) node.degree += 1;
}
