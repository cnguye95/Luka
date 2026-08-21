// The health check (handoff.md §10).
//
// "'Luka: Health check' rewrites `wiki/_health.md` wholesale from one vault
// scan, no model calls: unresolved wikilinks grouped by target (labeled
// 'article candidates'), orphan pages (no inbound links), citation entries
// pointing at raw files absent from the manifest, filed answer-sources list
// with ages, and count summaries."
//
// Every section is a question about the vault that has a right answer today and
// a different one tomorrow, which is why the file is rewritten wholesale rather
// than merged: §16 forbids an LLM-driven health check, and a half-stale report
// is worse than none.
import type { FsAdapter } from "./adapters";
import { decodeUtf8 } from "./hash";
import { loadManifest } from "./manifest";
import { comparePaths } from "./paths";
import { parseFrontmatter } from "./yaml";
import { buildGraph } from "./graph/build";
import { buildTitleIndex, linkTargets } from "./compile/links";
import { handleOf, loadPageTable } from "./compile/pagetable";
import { parseCitationBlock } from "./compile/citations";
import { FILED_ANSWERS_FOLDER } from "./answer/fileback";
import type { IngestManifest, PageMeta } from "./types";

/** Invariant 8 makes the report itself infrastructure: never a node, never a candidate. */
export const HEALTH_PATH = "wiki/_health.md";

export interface HealthDeps {
  fs: FsAdapter;
  manifestPath: string;
  now?: () => Date;
}

/** Rewrites `wiki/_health.md`. No model calls, by §10 and §16. */
export async function healthCheck(deps: HealthDeps): Promise<void> {
  const { fs, manifestPath } = deps;
  const pages = await loadPageTable(fs);
  const manifest = await loadManifest(fs, manifestPath);
  const graph = await buildGraph({ fs, manifestPath });
  const now = (deps.now ?? (() => new Date()))();

  const report = [
    "# Health",
    "",
    `Written ${now.toISOString().slice(0, 10)} from one scan of the vault. No model was asked.`,
    "",
    ...(await articleCandidates(fs, pages)),
    "",
    ...orphanPages(graph),
    "",
    ...(await danglingCitations(fs, pages, manifest)),
    "",
    ...(await filedAnswers(fs, manifest, now)),
    "",
    ...counts(pages, graph, manifest),
    "",
  ];

  await fs.mkdir("wiki");
  await fs.write(HEALTH_PATH, report.join("\n"));
}

/**
 * §10's "unresolved wikilinks grouped by target (labeled 'article
 * candidates')".
 *
 * §4 calls an unresolved link "a future-article signal, not an error", so the
 * report reads as a list of things worth writing rather than a list of faults —
 * and the ones many pages reach for come first.
 */
async function articleCandidates(fs: FsAdapter, pages: readonly PageMeta[]): Promise<string[]> {
  const index = buildTitleIndex(pages);
  const wanted = new Map<string, Set<string>>();

  for (const page of pages) {
    let text: string;
    try {
      text = decodeUtf8(await fs.read(page.path));
    } catch {
      continue;
    }
    for (const target of linkTargets(text)) {
      // Links into sources are full-path and are not title-resolved (§4), and
      // a heading or block reference addresses a place inside a page.
      if (target.startsWith("raw/") || target.includes("#") || target.includes("^")) continue;
      if (index.has(handleOf(target))) continue;
      const citers = wanted.get(target) ?? new Set<string>();
      citers.add(page.title);
      wanted.set(target, citers);
    }
  }

  if (wanted.size === 0) return ["## Article candidates", "", "None — every link resolves."];

  // Most-wanted first; ties by name, so the order does not depend on scan order.
  const ordered = [...wanted.entries()].sort(
    (a, b) => b[1].size - a[1].size || comparePaths(a[0], b[0]),
  );
  return [
    "## Article candidates",
    "",
    "Links that resolve to nothing yet — §4 calls these future-article signals, not errors.",
    "",
    ...ordered.map(([target, citers]) => {
      const from = [...citers].sort(comparePaths);
      return `- **${target}** — wanted by ${String(from.length)}: ${from.join(", ")}`;
    }),
  ];
}

/** §10's "orphan pages (no inbound links)". */
function orphanPages(graph: Awaited<ReturnType<typeof buildGraph>>): string[] {
  // The graph is undirected, so "no inbound links" and "degree 0" are the same
  // question — a page nothing links to and which links to nothing reachable.
  const orphans = graph.nodes
    .filter((node) => node.kind !== "raw" && node.degree === 0)
    .map((node) => node.path)
    .sort(comparePaths);

  if (orphans.length === 0) return ["## Orphan pages", "", "None — every page is connected."];
  return [
    "## Orphan pages",
    "",
    "Nothing links to these, and they link to nothing that exists.",
    "",
    ...orphans.map((path) => `- [[${path}]]`),
  ];
}

/**
 * §10's "citation entries pointing at raw files absent from the manifest".
 *
 * A citation block is §6.5's persistent citer record, so an entry naming a
 * source the manifest does not know is a page claiming grounding that compile
 * cannot account for.
 */
async function danglingCitations(
  fs: FsAdapter,
  pages: readonly PageMeta[],
  manifest: IngestManifest,
): Promise<string[]> {
  const dangling: string[] = [];

  for (const page of pages) {
    let text: string;
    try {
      text = decodeUtf8(await fs.read(page.path));
    } catch {
      continue;
    }
    for (const entry of parseCitationBlock(text).entries) {
      if (!entry.startsWith("raw/")) continue;
      // `Object.hasOwn`, not `manifest[entry] !== undefined`: a citation entry
      // is free text read off disk, so `constructor` and `toString` are
      // reachable targets that would otherwise resolve to Object.prototype.
      if (Object.hasOwn(manifest, entry)) continue;
      dangling.push(`- [[${page.title}]] cites \`${entry}\`, which the manifest does not know`);
    }
  }

  if (dangling.length === 0) {
    return ["## Citations without a source", "", "None — every cited file is a known source."];
  }
  return ["## Citations without a source", "", ...dangling.sort(comparePaths)];
}

/** §10's "filed answer-sources list with ages". */
async function filedAnswers(
  fs: FsAdapter,
  manifest: IngestManifest,
  now: Date,
): Promise<string[]> {
  const filed = Object.keys(manifest)
    .filter((path) => path.startsWith(`${FILED_ANSWERS_FOLDER}/`))
    .sort(comparePaths);

  if (filed.length === 0) {
    return ["## Filed answers", "", "None yet — answers are filed with “Luka: File this answer”."];
  }

  const lines: string[] = [];
  for (const path of filed) {
    lines.push(`- \`${path}\` — ${await ageOf(fs, path, now)}`);
  }
  return ["## Filed answers", "", ...lines];
}

/**
 * How long ago the answer was asked, from its own `asked` frontmatter.
 *
 * "unknown" when the key is missing or unreadable rather than falling back to a
 * file mtime: §4 records when the question was asked, and a sync or a copy
 * would make the filesystem answer a different question.
 */
async function ageOf(fs: FsAdapter, path: string, now: Date): Promise<string> {
  let asked: unknown;
  try {
    asked = parseFrontmatter(decodeUtf8(await fs.read(path))).data["asked"];
  } catch {
    return "age unknown";
  }
  if (typeof asked !== "string") return "age unknown";
  const at = new Date(asked);
  if (Number.isNaN(at.getTime())) return "age unknown";

  const days = Math.floor((now.getTime() - at.getTime()) / 86_400_000);
  if (days < 0) return "asked in the future";
  if (days === 0) return "asked today";
  return `${String(days)} day${days === 1 ? "" : "s"} old`;
}

/** §10's "count summaries". */
function counts(
  pages: readonly PageMeta[],
  graph: Awaited<ReturnType<typeof buildGraph>>,
  manifest: IngestManifest,
): string[] {
  const byKind = { source: 0, entity: 0, concept: 0 };
  for (const page of pages) byKind[page.kind] += 1;

  return [
    "## Counts",
    "",
    `- sources in the manifest: ${String(Object.keys(manifest).length)}`,
    `- wiki pages: ${String(pages.length)} (${String(byKind.source)} source, ` +
      `${String(byKind.entity)} entity, ${String(byKind.concept)} concept)`,
    `- graph: ${String(graph.nodes.length)} nodes, ${String(graph.edges.length)} edges`,
  ];
}

