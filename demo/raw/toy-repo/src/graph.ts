const WIKILINK = /\[\[([^\]|#^]+)/g;

/** Every distinct wikilink target named in a body, in first-seen order. */
export function linkTargets(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(WIKILINK)) {
    const target = (match[1] ?? "").trim();
    if (target !== "") seen.add(target);
  }
  return [...seen];
}

/** Undirected degree of every node, keyed by path. */
export function degrees(edges: readonly (readonly [string, string])[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [a, b] of edges) {
    out.set(a, (out.get(a) ?? 0) + 1);
    out.set(b, (out.get(b) ?? 0) + 1);
  }
  return out;
}
