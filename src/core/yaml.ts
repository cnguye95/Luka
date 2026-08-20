// Frontmatter read/write (handoff.md §4).
//
// Serialization must be byte-stable: a passthrough source is hashed *after* its
// frontmatter is written (§6.2), so any drift here would make every compile see
// the file as modified again.
import { dump, load } from "js-yaml";

export interface ParsedFrontmatter {
  /** Whether the document opened with a `---` fence at all. */
  present: boolean;
  /** `{}` for an absent, empty, or unparseable block. */
  data: Record<string, unknown>;
  /** Everything after the closing fence. */
  body: string;
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

/** The order §4 lists these keys in; anything else is appended alphabetically. */
const KEY_ORDER = [
  "kind",
  "ingested",
  "source-format",
  "origin-url",
  "derived-from",
  "source",
  "aliases",
  "summary",
  "updated",
  "question",
  "asked",
  "mode",
  "grounded",
];

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const match = FENCE.exec(text);
  if (!match) return { present: false, data: {}, body: text };

  let data: Record<string, unknown> = {};
  try {
    const parsed = load(match[1] ?? "");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // A source with a malformed block is still a source; treat its keys as absent.
  }
  return { present: true, data, body: text.slice(match[0].length) };
}

/** The complete block including both fences and a trailing newline. */
export function serializeFrontmatter(data: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    if (data[key] !== undefined) ordered[key] = data[key];
  }
  for (const key of Object.keys(data).sort()) {
    if (ordered[key] === undefined && data[key] !== undefined) ordered[key] = data[key];
  }
  if (Object.keys(ordered).length === 0) return "---\n---\n";
  // lineWidth -1 disables wrapping so long values cannot reflow between runs.
  return `---\n${dump(ordered, { lineWidth: -1, noRefs: true })}---\n`;
}

/** Writes the block only when the document has none (invariant 7). */
export function ensureFrontmatter(text: string, data: Record<string, unknown>): string {
  if (parseFrontmatter(text).present) return text;
  return serializeFrontmatter(data) + text;
}
