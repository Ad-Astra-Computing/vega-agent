import { describe, it, expect } from "vitest";
import { partitionByUpstream } from "../src/agent/upstream.js";

describe("partitionByUpstream (skip-upstream caching)", () => {
  const NOVEL = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-my-config";
  const STOCK = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-glibc-2.40";

  it("keeps only paths the upstream cache does not already have", async () => {
    const fetchImpl = ((url: string) =>
      Promise.resolve(
        new Response(null, { status: url.includes("bbbbbbbb") ? 200 : 404 }),
      )) as unknown as typeof fetch;
    const { novel, upstream } = await partitionByUpstream([NOVEL, STOCK], "https://cache.nixos.org", fetchImpl);
    expect(novel).toEqual([NOVEL]);
    expect(upstream).toEqual([STOCK]);
  });

  it("treats an upstream network error as novel (upload rather than drop)", async () => {
    const fetchImpl = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const { novel } = await partitionByUpstream([NOVEL], "https://cache.nixos.org", fetchImpl);
    expect(novel).toEqual([NOVEL]);
  });

  it("preserves order and partitions every path under bounded concurrency", async () => {
    const paths = Array.from(
      { length: 200 },
      (_, i) => `/nix/store/${String(i).padStart(32, "0")}-pkg-${i}`,
    );
    const upstreamSet = new Set(paths.filter((_, i) => i % 2 === 0));
    const fetchImpl = ((url: string) =>
      new Promise((resolve) =>
        setTimeout(() => {
          const hash = url.split("/").pop()!.replace(".narinfo", "");
          const path = paths.find((p) => p.includes(hash.slice(0, 32)));
          resolve(new Response(null, { status: path && upstreamSet.has(path) ? 200 : 404 }));
        }, Math.floor((url.length * 7) % 5)),
      )) as unknown as typeof fetch;
    const { novel, upstream } = await partitionByUpstream(paths, "https://cache.nixos.org", fetchImpl, 8);
    expect(novel.length + upstream.length).toBe(paths.length);
    expect(upstream).toEqual(paths.filter((p) => upstreamSet.has(p)));
    expect(novel).toEqual(paths.filter((p) => !upstreamSet.has(p)));
  });

  it("checks upstream even when concurrency is given as zero (clamps to >= 1)", async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls++;
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const { upstream } = await partitionByUpstream([NOVEL, STOCK], "https://cache.nixos.org", fetchImpl, 0);
    expect(calls).toBe(2);
    expect(upstream).toEqual([NOVEL, STOCK]);
  });
});
