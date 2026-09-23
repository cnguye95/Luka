// Where a source's readable markdown is — one rule, in one place.
//
// A source's readable markdown is the source itself if `.md`/`.txt`, else its
// derivative. Three functions used to answer that, from three different
// inputs, and they disagreed on the same case: a converting source with no
// derivative recorded. Two returned the source path, which for a PDF means
// handing raw bytes to a model under the label of its extracted text, or
// making the PDF a graph node when it is not one. The third refused it, with a
// comment explaining why the other answer was wrong. That is the shape
// CLAUDE.md's readable/live seam names: local fixes drift the siblings, so the
// rule has to live somewhere the siblings all read from.
//
// Three inputs remain, because the callers genuinely differ — one holds a
// manifest entry, one holds a normalize outcome, one has to touch the disk —
// but they now differ only in how they *reach* the rule, not in what it says.
import { formatForPath, isPassthrough } from "./normalize/index";

/**
 * The readable markdown for a source, or `null` when there is none.
 *
 * `null` has two causes and they are not the same thing. A pending source has
 * left the vault, so there is nothing to read. A converting source with no
 * derivative recorded is a source whose extracted text has not been located —
 * an entry written before the pointer was recorded, or one whose derivative a
 * user has moved — and the source itself is not a substitute for it.
 *
 * This is the path the entry names, not a promise that a file stands there. A
 * caller about to read it must still check, because a user can move, delete or
 * build a directory over a derivative between two compiles.
 */
export function readableMarkdown(
  path: string,
  derivative: string | undefined,
  pending: boolean,
): string | null {
  if (pending) return null;
  if (derivative !== undefined) return derivative;
  // No pointer, so the only source that is its own readable markdown is one
  // that was never converted.
  const format = formatForPath(path);
  return format !== null && isPassthrough(format) ? path : null;
}
