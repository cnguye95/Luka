export interface PprOptions {
  alpha: number;
  epsilon: number;
  maxIterations: number;
}

/** Power iteration for Personalized PageRank on an undirected graph. */
export function computePpr(
  adjacency: readonly (readonly number[])[],
  seeds: readonly number[],
  options: PprOptions,
): number[] {
  const n = adjacency.length;
  const teleport = new Array<number>(n).fill(0);
  for (const seed of seeds) teleport[seed] = 1 / seeds.length;

  let vector = teleport.slice();
  for (let iteration = 0; iteration < options.maxIterations; iteration++) {
    const next = new Array<number>(n).fill(0);
    for (let from = 0; from < n; from++) {
      const neighbours = adjacency[from] as readonly number[];
      if (neighbours.length === 0) continue;
      const share = (vector[from] as number) / neighbours.length;
      for (const to of neighbours) next[to] = (next[to] as number) + share;
    }
    let delta = 0;
    for (let i = 0; i < n; i++) {
      next[i] = options.alpha * (next[i] as number) + (1 - options.alpha) * (teleport[i] as number);
      delta += Math.abs((next[i] as number) - (vector[i] as number));
    }
    vector = next;
    if (delta < options.epsilon) break;
  }
  return vector;
}
