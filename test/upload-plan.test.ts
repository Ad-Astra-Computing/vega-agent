import { describe, it, expect } from "vitest";
import { planUploads } from "../src/agent/upload-plan.js";
import { narObjectExists } from "../src/agent/upstream.js";

// 32-char store hashes (nixbase32 alphabet) for three paths.
const A = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-a";
const B = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-b";
const C = "/nix/store/cccccccccccccccccccccccccccccccc-c";

/** A fake cache: HEAD a `<hash>.narinfo` returns 200 if the hash is in `present`
 * for that base URL, else 404. Lets us simulate upstream membership. */
function fakeCache(present: Record<string, string[]>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const m = /^(.*)\/([0-9a-z]+)\.narinfo$/.exec(url);
    const base = m?.[1] ?? "";
    const hash = m?.[2] ?? "";
    const ok = (present[base] ?? []).includes(hash);
    return new Response(null, { status: ok ? 200 : 404 });
  }) as unknown as typeof fetch;
}

describe("planUploads", () => {
  it("uploads everything when no skip URLs are given", async () => {
    const plan = await planUploads([A, B, C], {}, fakeCache({}));
    expect(plan.toUpload).toEqual([A, B, C]);
    expect(plan.skippedUpstream).toEqual([]);
  });

  it("drops paths the upstream cache already serves", async () => {
    const up = "https://cache.nixos.org";
    const plan = await planUploads([A, B, C], { upstreamUrl: up }, fakeCache({ [up]: ["a".repeat(32)] }));
    expect(plan.skippedUpstream).toEqual([A]);
    expect(plan.toUpload).toEqual([B, C]);
  });

  it("uploads a path on an upstream probe error (never silently dropped)", async () => {
    const up = "https://cache.nixos.org";
    const failing = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    const plan = await planUploads([A], { upstreamUrl: up }, failing);
    expect(plan.toUpload).toEqual([A]);
    expect(plan.skippedUpstream).toEqual([]);
  });
});

describe("narObjectExists (content-addressed resume probe)", () => {
  const base = "https://vega-cache.dev/tenant/org/repo";
  const narUrl = "nar/1abc.nar.zst";

  /** Records the probed URL/method and answers from a present-set of nar keys. */
  function fakeNarCache(present: string[]): { fetch: typeof fetch; seen: string[] } {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(null, { status: present.includes(url) ? 200 : 404 });
    }) as unknown as typeof fetch;
    return { fetch: fetchImpl, seen };
  }

  it("probes the content-addressed object key with HEAD, not the store-path narinfo", async () => {
    const { fetch: f, seen } = fakeNarCache([`${base}/${narUrl}`]);
    const present = await narObjectExists(base, narUrl, f);
    expect(present).toBe(true);
    expect(seen).toEqual([`HEAD ${base}/${narUrl}`]); // exact nar object, no .narinfo probe
  });

  it("returns false (re-upload) when the exact object is absent", async () => {
    const { fetch: f } = fakeNarCache([]);
    expect(await narObjectExists(base, narUrl, f)).toBe(false);
  });

  it("fails open to re-upload on a probe error, never skipping the PUT", async () => {
    const failing = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await narObjectExists(base, narUrl, failing)).toBe(false);
  });

  it("tolerates a trailing slash on the read base", async () => {
    const { fetch: f, seen } = fakeNarCache([`${base}/${narUrl}`]);
    expect(await narObjectExists(`${base}/`, narUrl, f)).toBe(true);
    expect(seen).toEqual([`HEAD ${base}/${narUrl}`]);
  });
});
