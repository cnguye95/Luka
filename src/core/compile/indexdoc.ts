// The index document `wiki/_index.md` (handoff.md §4), regenerated each
// compile from the in-memory page table.
//
// §7.4 step 1 reuses this exact renderer: "Page table (wiki pages only)
// renders to the same text as `_index.md`" — the seed call and the file the
// user reads must never drift apart, so there is one renderer, not two.
import { comparePaths } from "../paths";
import type { PageKind, PageMeta } from "../types";

export const INDEX_PATH = "wiki/_index.md";

const SECTIONS: readonly [string, PageKind][] = [
  ["Sources", "source"],
  ["Entities", "entity"],
  ["Concepts", "concept"],
];

export function renderIndex(pages: readonly PageMeta[]): string {
  const lines = ["# Index"];

  for (const [heading, kind] of SECTIONS) {
    lines.push(`## ${heading}`);
    const section = pages
      .filter((page) => page.kind === kind)
      .sort((a, b) => comparePaths(a.title, b.title));
    for (const page of section) lines.push(entryLine(page));
  }

  return `${lines.join("\n")}\n`;
}

function entryLine(page: PageMeta): string {
  let line = `- [[${page.title}]]`;

  const summary = oneLine(page.summary);
  if (summary !== "") line += ` — ${summary}`;

  const aliases = page.aliases.map(oneLine).filter((alias) => alias !== "");
  if (aliases.length > 0) line += ` (aliases: ${aliases.join(", ")})`;

  return line;
}

/**
 * Summaries and aliases originate in the model's Call A JSON (§6.5). Invariant
 * 5 gives the model prose only — never structure — so a newline in one of them
 * must not be able to inject a heading or a second entry into this document.
 * That matters twice over: §7.4 step 1 feeds this same text to the seed call.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
