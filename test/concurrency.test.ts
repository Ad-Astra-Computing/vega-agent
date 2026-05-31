import { describe, it, expect } from "vitest";
import { mapConcurrent } from "../src/agent/concurrency.js";

describe("mapConcurrent", () => {
  it("preserves order regardless of completion timing", async () => {
    const out = await mapConcurrent([5, 1, 4, 2, 3], 3, (n) =>
      new Promise<number>((r) => setTimeout(() => r(n * 10), n)),
    );
    expect(out).toEqual([50, 10, 40, 20, 30]);
  });

  it("processes every item exactly once", async () => {
    const seen: number[] = [];
    await mapConcurrent([0, 1, 2, 3, 4, 5, 6], 2, async (n) => {
      seen.push(n);
      return n;
    });
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("never exceeds the concurrency limit in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapConcurrent(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("handles an empty list and clamps a non-positive limit", async () => {
    expect(await mapConcurrent([], 4, async (n) => n)).toEqual([]);
    expect(await mapConcurrent([1, 2], 0, async (n) => n * 2)).toEqual([2, 4]);
  });
});
