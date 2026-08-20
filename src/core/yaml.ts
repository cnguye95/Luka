// Frontmatter read/write (handoff.md §4).
//
// Two hard constraints shape this module.
//
// Invariant 7: a user-placed file receives exactly three sanctioned in-place
// writes, one of which is "frontmatter written where absent". Keys the user
// wrote are theirs — this module never re-serializes them, because a
// load/dump round trip silently drops YAML comments, restyles flow sequences,
// reorders keys, and retypes scalars (`010` becomes `10`). New keys are
// spliced in as text and every existing byte is left exactly as written.
//
// §6.2: a passthrough source is hashed *after* annotation, so serialization
// must be byte-stable or every compile would see the file as modified again.
import { dump, load } from "js-yaml";

export interface ParsedFrontmatter {
  /** Whether the document opened with a `---` fence at all. */
  present: boolean;
  /**
   * Whether the block is a YAML mapping Luka may add keys to. False for a
   * malformed block, and for one holding a sequence or a bare scalar — both
   * are content this module must not touch.
   */
  mergeable: boolean;
  /** `{}` unless the block is a mapping. */
  data: Record<string, unknown>;
  /** Everything after the closing fence. */
  body: string;
}

/** Groups: opening fence, inner YAML, closing fence. */
const FENCE = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n?---[ \t]*(?:\r?\n|$))/;

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
  if (!match) return { present: false, mergeable: false, data: {}, body: text };

  const inner = match[2] ?? "";
  const body = text.slice(match[0].length);

  // An empty block is a mapping with no keys, and is safe to add to.
  if (inner.trim() === "") return { present: true, mergeable: true, data: {}, body };

  try {
    const parsed = load(inner);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { present: true, mergeable: true, data: parsed as Record<string, unknown>, body };
    }
  } catch {
    // Falls through: a block Luka cannot read is a block Luka must not edit.
  }
  return { present: true, mergeable: false, data: {}, body };
}

/** The complete block including both fences and a trailing newline. */
export function serializeFrontmatter(data: Record<string, unknown>): string {
  return `---\n${renderKeys(data)}---\n`;
}

function renderKeys(data: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    if (data[key] !== undefined) ordered[key] = data[key];
  }
  for (const key of Object.keys(data).sort()) {
    if (ordered[key] === undefined && data[key] !== undefined) ordered[key] = data[key];
  }
  if (Object.keys(ordered).length === 0) return "";
  // lineWidth -1 disables wrapping so long values cannot reflow between runs.
  return dump(ordered, { lineWidth: -1, noRefs: true });
}

/**
 * Rewrites the value of a single existing key, leaving every other byte of the
 * document alone — including the rest of the frontmatter.
 *
 * Used to point a derivative's `derived-from` at its source's new path after a
 * rename. §6.2 invites the user to edit a derivative (it is the sanctioned
 * repair path for a bad extraction), so even though invariant 7 makes the file
 * Luka's to rewrite, re-serializing the block would throw away their comments
 * and restyle their YAML for the sake of one word.
 *
 * Returns `null` when the key is not there as a simple `key: value` line, so
 * the caller can fall back rather than guess.
 */
export function replaceFrontmatterValue(
  text: string,
  key: string,
  value: string,
): string | null {
  const match = FENCE.exec(text);
  if (!match) return null;

  const inner = match[2] ?? "";
  const line = new RegExp(`^([ \\t]*${escapeForRegExp(key)}[ \\t]*:[ \\t]*)(.*)$`, "m");
  if (!line.test(inner)) return null;

  const rendered = dump({ [key]: value }, { lineWidth: -1, noRefs: true })
    .slice(key.length + 1)
    .trim();
  const rewritten = inner.replace(line, (_full, prefix: string) => `${prefix}${rendered}`);

  return match[1] + rewritten + match[3] + text.slice(match[0].length);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Adds the keys of `data` that the document does not already have, and nothing
 * else. Returns `text` unchanged when there is nothing to add, so re-running
 * annotation is a no-op down to the byte.
 *
 * A document with no frontmatter gains a block. A document whose block is
 * malformed, or holds a sequence or scalar rather than a mapping, is returned
 * untouched — there is no way to add a key to it without rewriting content the
 * user owns.
 */
export function ensureFrontmatter(text: string, data: Record<string, unknown>): string {
  const match = FENCE.exec(text);
  if (!match) {
    const block = renderKeys(data);
    return block === "" ? text : `---\n${block}---\n${text}`;
  }

  const parsed = parseFrontmatter(text);
  if (!parsed.mergeable) return text;

  const missing: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && parsed.data[key] === undefined) missing[key] = value;
  }

  const addition = renderKeys(missing);
  if (addition === "") return text;

  // Spliced between the fences: match[2] carries the user's bytes verbatim.
  return match[1] + addition + match[2] + match[3] + parsed.body;
}
