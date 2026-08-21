// §7.4 step 4: "Assemble top-K whole nodes (wiki or source content) in rank
// order under the context budget (default 40,000 tokens ≈ chars/4; K cap 12).
// Never split a page; a single page over the whole budget is tail-truncated
// with the marker."
//
// Every one of those rules is already `packUnderBudget`'s contract — it stops
// at the first item that does not fit rather than cherry-picking a later small
// one, and it truncates the first item rather than dropping it. §6.5's page
// assembly and §7.4's top-K assembly share that definition of "fits" on
// purpose, so this module supplies the texts and the cap and nothing else.
import type { FsAdapter } from "../adapters";
import { decodeUtf8 } from "../hash";
import { parseFrontmatter } from "../yaml";
import { packUnderBudget } from "../tokens";
import { truncatedForContextBudget } from "../markers";
import type { RankedNode } from "./pipeline";
import type { PageKind } from "../types";

export interface AssembledNode {
  path: string;
  title: string;
  kind: PageKind | "raw";
  /** The node's own text, frontmatter stripped. */
  text: string;
  truncated: boolean;
}

export interface Assembly {
  nodes: AssembledNode[];
  usedTokens: number;
}

/**
 * Reads the ranked nodes in order and packs as many whole ones as the budget
 * holds.
 *
 * A node that cannot be read is skipped rather than failing the query: it was
 * ranked from the page table or the manifest, both of which can name a file a
 * user has moved since. The answer is then grounded in one fewer source, which
 * the citation block and the trace both record honestly.
 */
export async function assemble(
  fs: FsAdapter,
  ranked: readonly RankedNode[],
  budgetTokens: number,
  cap: number,
): Promise<Assembly> {
  const readable: { node: RankedNode; text: string }[] = [];
  for (const node of ranked) {
    // Stop reading once enough whole nodes are in hand: §7.4 takes the top K,
    // so reading the rest of a large vault would be work nothing consumes.
    if (readable.length === cap) break;
    let text: string;
    try {
      text = bodyOf(decodeUtf8(await fs.read(node.path)));
    } catch {
      continue;
    }
    if (text.trim() === "") continue;
    readable.push({ node, text });
  }

  const packed = packUnderBudget(readable, (item) => item.text, budgetTokens, cap);

  const nodes: AssembledNode[] = packed.items.map((item, at) => {
    const text = packed.texts[at] as string;
    return {
      path: item.node.path,
      title: item.node.title,
      kind: item.node.kind,
      text,
      // Only the first item can be truncated — `packUnderBudget` drops the
      // rest rather than splitting them — so the flag belongs to it alone.
      truncated: at === 0 && packed.truncated,
    };
  });

  return { nodes, usedTokens: packed.usedTokens };
}

/** True when any assembled node carries §7.4's truncation marker. */
export function wasTruncated(assembly: Assembly): boolean {
  return assembly.nodes.some((node) => node.truncated);
}

/**
 * The marker §7.4 asks for on a tail-truncated node, so a caller rendering the
 * prompt does not have to know how `tokens.ts` spells it.
 */
export const TRUNCATION_MARKER = truncatedForContextBudget();

function bodyOf(text: string): string {
  return parseFrontmatter(text).body;
}
