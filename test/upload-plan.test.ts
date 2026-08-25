import { describe, it, expect } from "vitest";
import { planUploads } from "../src/agent/upload-plan.js";
import { narObjectExists } from "../src/agent/upstream.js";

// 32-char store hashes (nixbase32 alphabet) for three paths.
const A = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-a";
const B = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-b";
const C = "/nix/store/cccccccccccccccccccccccccccccccc-c";
const EROFS = "/nix/store/dddddddddddddddddddddddddddddddd-microvm-store-disk.erofs";

/** planUploads takes closure entries, since a size ceiling needs the size. */
const e = (path: string, narSize = 1024) => ({ path, narSize });

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
    const plan = await planUploads([e(A), e(B), e(C)], {}, fakeCache({}));
    expect(plan.toUpload).toEqual([A, B, C]);
    expect(plan.skippedUpstream).toEqual([]);
  });

  it("drops a path whose NAME matches an exclude glob, and says so", async () => {
    // The case this exists for: a host-specific microVM disk image, gigabytes,
    // that no other machine will ever substitute.
    const plan = await planUploads(
      [e(A), e(EROFS, 1_500_000_000)],
      { exclude: ["*.erofs"] },
      fakeCache({}),
    );
    expect(plan.toUpload).toEqual([A]);
    expect(plan.skippedByPolicy).toEqual([
      { path: EROFS, narSize: 1_500_000_000, reason: "excluded" },
    ]);
  });

  it("matches the name, not the hash, so a pattern survives a rebuild", async () => {
    // A pattern written against the full path would match one build and never
    // again, because the hash changes every time.
    const rebuilt = "/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-microvm-store-disk.erofs";
    const plan = await planUploads([e(rebuilt)], { exclude: ["microvm-store-disk.erofs"] }, fakeCache({}));
    expect(plan.toUpload).toEqual([]);
  });

  it("treats a glob as a glob, not as a regex", async () => {
    // `.` is a literal, or `hello-2.12.1` would also exclude `hello-2X12.1`.
    const other = "/nix/store/ffffffffffffffffffffffffffffffff-hello-2X12.1";
    const plan = await planUploads([e(other)], { exclude: ["hello-2.12.1"] }, fakeCache({}));
    expect(plan.toUpload).toEqual([other]);
  });

  it("drops a path over the size ceiling", async () => {
    const plan = await planUploads(
      [e(A, 100), e(B, 5_000_000_000)],
      { maxNarBytes: 1_000_000_000 },
      fakeCache({}),
    );
    expect(plan.toUpload).toEqual([A]);
    expect(plan.skippedByPolicy[0]).toMatchObject({ path: B, reason: "too-large" });
  });

  it("does not probe upstream for a path policy already dropped", async () => {
    // Dropping costs nothing; probing costs a request. A closure full of
    // excluded paths should not spend the network on them.
    const up = "https://cache.nixos.org";
    let probes = 0;
    const counting = (async (input: RequestInfo | URL) => {
      probes++;
      void input;
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    await planUploads([e(A), e(EROFS)], { upstreamUrl: up, exclude: ["*.erofs"] }, counting);
    expect(probes).toBe(1); // A only
  });

  it("excludes nothing when the patterns are empty or blank", async () => {
    const plan = await planUploads([e(A), e(B)], { exclude: ["", "  "] }, fakeCache({}));
    expect(plan.toUpload).toEqual([A, B]);
    expect(plan.skippedByPolicy).toEqual([]);
  });

  it("drops paths the upstream cache already serves", async () => {
    const up = "https://cache.nixos.org";
    const plan = await planUploads([e(A), e(B), e(C)], { upstreamUrl: up }, fakeCache({ [up]: ["a".repeat(32)] }));
    expect(plan.skippedUpstream).toEqual([A]);
    expect(plan.toUpload).toEqual([B, C]);
  });

  it("uploads a path on an upstream probe error (never silently dropped)", async () => {
    const up = "https://cache.nixos.org";
    const failing = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    const plan = await planUploads([e(A)], { upstreamUrl: up }, failing);
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
