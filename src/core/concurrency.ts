/**
 * Maps `items` through `fn` with at most `limit` in flight, preserving input
 * order in the result. Used by inline-image localization (§6.3, fixed cap 4);
 * compile's model-call fan-out (§11, concurrency 2) becomes its second
 * consumer at M2c.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
