import { describe, it, expect } from "vitest";
import { withRetry, type FetchResult } from "./verify-core.js";

/** A scripted fetcher: returns the next queued status (or throws if the entry is
 * an Error), counting calls. Body readers are stubbed. */
function scripted(seq: Array<number | Error>) {
  let i = 0;
  let calls = 0;
  const fetcher = async (_path: string): Promise<FetchResult> => {
    calls++;
    const v = seq[Math.min(i++, seq.length - 1)]!;
    if (v instanceof Error) throw v;
    return { ok: v < 400, status: v, text: async () => "", json: async () => ({}) };
  };
  return { fetcher, calls: () => calls };
}

const noSleep = (_ms: number) => Promise.resolve();

describe("withRetry", () => {
  it("retries a transient 5xx and returns the eventual success", async () => {
    const s = scripted([500, 503, 200]);
    const res = await withRetry(s.fetcher, { tries: 3, sleep: noSleep })("/x");
    expect(res.status).toBe(200);
    expect(s.calls()).toBe(3);
  });

  it("does NOT retry a 4xx (a 404 is a real answer)", async () => {
    const s = scripted([404, 200]);
    const res = await withRetry(s.fetcher, { tries: 3, sleep: noSleep })("/x");
    expect(res.status).toBe(404);
    expect(s.calls()).toBe(1);
  });

  it("retries a thrown network error then succeeds", async () => {
    const s = scripted([new Error("ECONNRESET"), 200]);
    const res = await withRetry(s.fetcher, { tries: 3, sleep: noSleep })("/x");
    expect(res.status).toBe(200);
    expect(s.calls()).toBe(2);
  });

  it("returns the last 5xx after exhausting tries (does not loop forever)", async () => {
    const s = scripted([500, 500, 500]);
    const res = await withRetry(s.fetcher, { tries: 3, sleep: noSleep })("/x");
    expect(res.status).toBe(500);
    expect(s.calls()).toBe(3);
  });

  it("re-throws a persistent network error after exhausting tries", async () => {
    const s = scripted([new Error("down")]);
    await expect(withRetry(s.fetcher, { tries: 2, sleep: noSleep })("/x")).rejects.toThrow(/down/);
    expect(s.calls()).toBe(2);
  });

  it("passes a 2xx straight through with no retry", async () => {
    const s = scripted([200]);
    expect((await withRetry(s.fetcher, { sleep: noSleep })("/x")).status).toBe(200);
    expect(s.calls()).toBe(1);
  });
});
