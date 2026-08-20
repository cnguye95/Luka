import { describe, expect, it, vi } from "vitest";
import { mapWithConcurrency } from "../src/core/concurrency";

describe("mapWithConcurrency", () => {
  it("preserves input order in the results regardless of completion order", async () => {
    const delays = [40, 5, 25, 0, 15];
    const results = await mapWithConcurrency(delays, 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `done-${ms}`;
    });
    expect(results).toEqual(["done-40", "done-5", "done-25", "done-0", "done-15"]);
  });

  it("never runs more than `limit` items at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];

    const all = mapWithConcurrency([...Array(9).keys()], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight -= 1;
      return n * 2;
    });

    let released = 0;
    while (released < 9) {
      await vi.waitFor(() => expect(release.length).toBeGreaterThan(0));
      (release.shift() as () => void)();
      released += 1;
    }

    expect(await all).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16]);
    expect(peak).toBe(3);
  });

  it("handles a limit larger than the item count, and an empty list", async () => {
    await expect(mapWithConcurrency([1, 2], 10, async (n) => n)).resolves.toEqual([1, 2]);
    await expect(mapWithConcurrency([], 4, async () => "x")).resolves.toEqual([]);
  });
});
