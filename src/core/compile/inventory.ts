// Call A — inventory.
//
// Per changed source, the input is the normalized markdown (frontmatter
// stripped; body only); the output is strict JSON `{ "source_summary": str,
// "items": [{ "title": str, "kind": "entity"|"concept", "aliases": [str],
// "summary": str }] }`. The prompt must instruct: qualified titles for
// ambiguous names ("Mercury (element)"); aliases include obvious variants;
// temperature 0.
//
// Temperature 0 is not set here: the wrapper fixes it for every `json: true`
// task, so this module cannot get it wrong.
import type { LLMProvider } from "../provider/types";
import { parseFrontmatter } from "../yaml";

export interface InventoryItem {
  title: string;
  kind: "entity" | "concept";
  aliases: string[];
  summary: string;
}

export interface SourceInventory {
  sourceSummary: string;
  items: InventoryItem[];
}

const SYSTEM = [
  "You are the extraction step of a personal knowledge wiki compiler.",
  "You are given the body of one source document.",
  "",
  "Reply with strict JSON and nothing else — no prose, no markdown fence:",
  '{"source_summary": "<one line describing this source>",',
  ' "items": [{"title": "...", "kind": "entity" | "concept",',
  '            "aliases": ["..."], "summary": "<one line>"}]}',
  "",
  "Rules:",
  "- Inventory the entities and concepts this source is actually about.",
  "  An entity is a named thing (a person, organization, place, product, work).",
  "  A concept is an idea, method, or phenomenon.",
  "- Use qualified titles for ambiguous names: \"Mercury (element)\", not \"Mercury\".",
  "- aliases must include the obvious variants a reader would use: abbreviations,",
  "  expansions, common spellings, and the unqualified form of a qualified title.",
  "- Summaries are one line each.",
  "- Return an empty items list if the source names nothing worth a page.",
].join("\n");

/**
 * Runs Call A over one source body.
 *
 * Throws when the reply is not the documented shape. The caller treats that as
 * a failed source: it is skipped with a notice and invariant 3's success-only
 * manifest retries it next compile.
 */
export async function takeInventory(
  provider: LLMProvider,
  body: string,
): Promise<SourceInventory> {
  const reply = await provider.complete({
    task: "inventory",
    json: true,
    system: SYSTEM,
    user: body,
  });

  if (reply === null || typeof reply !== "object" || Array.isArray(reply)) {
    throw new Error("inventory reply was not a JSON object");
  }
  const record = reply as Record<string, unknown>;

  const summary = record["source_summary"];
  if (typeof summary !== "string") {
    throw new Error("inventory reply has no source_summary string");
  }
  const rawItems = record["items"];
  if (!Array.isArray(rawItems)) {
    throw new Error("inventory reply has no items array");
  }

  // Individual malformed items are dropped rather than failing the source:
  // one bad entry should not cost the user the whole document.
  const items: InventoryItem[] = [];
  for (const candidate of rawItems) {
    const item = toItem(candidate);
    if (item !== null) items.push(item);
  }

  return { sourceSummary: oneLine(summary), items };
}

function toItem(value: unknown): InventoryItem | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  // Flattened before anything else sees it: the title becomes a filename, a
  // frontmatter value, an index entry and a [[link]], and a newline in any of
  // those is structure the model does not get to write (invariant 5).
  const title = typeof record["title"] === "string" ? oneLine(record["title"]) : "";
  if (title === "") return null;

  const kind = record["kind"];
  if (kind !== "entity" && kind !== "concept") return null;

  return {
    title,
    kind,
    aliases: toStringArray(record["aliases"]),
    summary: typeof record["summary"] === "string" ? oneLine(record["summary"]) : "",
  };
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    const single = oneLine(value);
    return single === "" ? [] : [single];
  }
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    // Flattened like every other model string: an alias reaches page
    // frontmatter, and a newline there renders as a YAML block scalar — the
    // model would have determined the structure of a block invariant 5 gives
    // to code alone. `pagetable` reads these back on every compile.
    const flat = oneLine(item);
    if (flat !== "") out.push(flat);
  }
  return out;
}

/**
 * Invariant 5 gives the model prose, never structure. A newline in a summary
 * would reach `wiki/_index.md` (and from there the seed call), so it is
 * flattened at the point the model's words enter the system.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Call A sees the body only. */
export function bodyOf(markdown: string): string {
  return parseFrontmatter(markdown).body;
}
