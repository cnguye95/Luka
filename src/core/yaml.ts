// Frontmatter read/write.
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
// A passthrough source is hashed *after* annotation, so serialization
// must be byte-stable or every compile would see the file as modified again.
import { dump, load } from "js-yaml";

export interface ParsedFrontmatter {
  /** The document opens a `---` fence — not that this reader could parse it. */
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

/**
 * Groups: opening fence, inner YAML, closing fence.
 *
 * The closing `---` must begin a line, which is why the inner group either is
 * empty or ends with a newline rather than letting the fence float. A pattern
 * that accepts `---` mid-line reports a block no other YAML reader agrees
 * with: `derived-from: raw/a.pdf---` would be read as `raw/a.pdf`, and since
 * this is the only reader of that key, a user's own file could be accepted as
 * Luka's and overwritten. It also has to survive a `---` line *inside* a block
 * scalar, which would otherwise truncate the block and lose every key below it
 * — including the ownership key, on exactly the sanctioned hand-edit.
 */
const FENCE = /^(---[ \t]*\r?\n)((?:[\s\S]*?\r?\n)?)(---[ \t]*(?:\r?\n|$))/;

/**
 * A document that opens a fence has frontmatter, whether or not this reader
 * can find where it ends.
 *
 * Anchoring the close to a line start is right, but on its own it turns every
 * shape it now refuses — `----`, an indented `---`, a fence never closed —
 * from "left untouched" into "a second block prepended in front of the first".
 * Those are sanctioned hand-edits, and prepending to one is a write to a
 * file the user owns that no rule sanctions. Unparseable frontmatter is still
 * frontmatter: the document is left exactly as it stands.
 */
const OPENING_FENCE = /^---[ \t]*\r?\n/;

/**
 * The fixed order for the keys Luka writes, with `missing` after `grounded` —
 * a later addition to the answer frontmatter. Anything else is appended
 * alphabetically.
 */
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
  "missing",
];

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const match = FENCE.exec(text);
  if (!match) {
    return { present: OPENING_FENCE.test(text), mergeable: false, data: {}, body: text };
  }

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
  // A Map, not an object literal: `ordered[key] !== undefined` consults
  // Object.prototype, so keys named `constructor` or `toString` test as already
  // present and are dropped, and assigning `__proto__` reparents the
  // accumulator instead of adding to it. Page frontmatter is re-serialized from
  // whatever a document carries, so those names are reachable.
  const ordered = new Map<string, unknown>();
  for (const key of KEY_ORDER) {
    if (data[key] !== undefined) ordered.set(key, data[key]);
  }
  for (const key of Object.keys(data).sort()) {
    if (!ordered.has(key) && data[key] !== undefined) ordered.set(key, data[key]);
  }
  if (ordered.size === 0) return "";
  // lineWidth -1 disables wrapping so long values cannot reflow between runs.
  return dump(Object.fromEntries(ordered), { lineWidth: -1, noRefs: true });
}

/**
 * Rewrites the value of a single existing key, leaving every other byte of the
 * document alone — including the rest of the frontmatter.
 *
 * Used to point a derivative's `derived-from` at its source's new path after a
 * rename. The user is invited to edit a derivative (it is the sanctioned
 * repair path for a bad extraction), so even though invariant 7 makes the file
 * Luka's to rewrite, re-serializing the block would throw away their comments
 * and restyle their YAML for the sake of one word. Any comment on the rewritten
 * line itself goes with the value it annotated.
 *
 * Returns `null` — never a guess — unless the key is present exactly once, at
 * the top level of the block, holding a plain single-line scalar. A nested key
 * of the same name, a block scalar, or a quoted key all decline: rewriting the
 * wrong line, or half of a folded value, corrupts a file the caller believes it
 * has just corrected.
 */
export function replaceFrontmatterValue(
  text: string,
  key: string,
  value: string,
): string | null {
  const match = FENCE.exec(text);
  if (!match) return null;

  const inner = match[2] ?? "";
  // Anchored at column zero: an indented `derived-from:` belongs to some
  // mapping the user nested, not to the document.
  const line = new RegExp(`^${escapeForRegExp(key)}[ \\t]*:[ \\t]*(.*)$`, "gm");
  const hits = [...inner.matchAll(line)];
  if (hits.length !== 1) return null;

  const current = (hits[0]?.[1] ?? "").trim();
  // `|` and `>` open a scalar that continues onto the following lines, and an
  // empty value may do the same. Only what is wholly on this line can be
  // replaced by rewriting this line.
  if (current === "" || current.startsWith("|") || current.startsWith(">")) return null;

  const rendered = dump(value, { lineWidth: -1, noRefs: true }).trimEnd();
  if (rendered.includes("\n")) return null;

  const at = hits[0]?.index ?? 0;
  const rewritten =
    inner.slice(0, at) +
    `${key}: ${rendered}` +
    inner.slice(at + (hits[0]?.[0].length ?? 0));

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
    if (OPENING_FENCE.test(text)) return text;
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
