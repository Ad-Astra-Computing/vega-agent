import { describe, it, expect } from "vitest";
import { planUploads, globMatches, storePathName, parseByteCeiling, matchedPatterns, unmatchedPatterns } from "../src/agent/upload-plan.js";
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

describe("globMatches", () => {
  it("matches a wildcard-heavy pattern in bounded time", () => {
    // The regex form of this (each * as .*) backtracks catastrophically: minutes
    // for one 211-character name, once per closure entry, during planning before
    // the stall watchdog starts, so the job wedges with no diagnostic.
    const started = process.hrtime.bigint();
    expect(globMatches("*a*a*a*a*a*a*a*a*a*b", "a".repeat(211))).toBe(false);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(100);
  });

  it("matches a literal * in the name with a wildcard", () => {
    // Nix rejects * in a store name, so this is unreachable from a closure, but
    // the function is exported and the literal branch must not shadow the star.
    expect(globMatches("*", "*a")).toBe(true);
    expect(globMatches("*b", "*ab")).toBe(true);
  });

  it("treats ? as exactly one character", () => {
    expect(globMatches("hello-?", "hello-1")).toBe(true);
    expect(globMatches("hello-?", "hello-12")).toBe(false);
    expect(globMatches("hello-?", "hello-")).toBe(false);
  });

  it("treats regex metacharacters as literals", () => {
    expect(globMatches("hello-2.12.1", "hello-2.12.1")).toBe(true);
    expect(globMatches("hello-2.12.1", "hello-2X12.1")).toBe(false);
    expect(globMatches("a+b(c)", "a+b(c)")).toBe(true);
  });

  it("anchors both ends", () => {
    expect(globMatches("erofs", "microvm-store-disk.erofs")).toBe(false);
    expect(globMatches("*.erofs", "microvm-store-disk.erofs")).toBe(true);
  });
});

describe("storePathName", () => {
  it("takes everything after the first dash, keeping dashes in the name", () => {
    expect(storePathName("/nix/store/" + "a".repeat(32) + "-gcc-13.2.0-dev")).toBe("gcc-13.2.0-dev");
  });
});

describe("parseByteCeiling", () => {
  it("is absent for an unset or empty value", () => {
    expect(parseByteCeiling(undefined, "X")).toBeUndefined();
    expect(parseByteCeiling("  ", "X")).toBeUndefined();
  });

  it("parses a plain byte count", () => {
    expect(parseByteCeiling("100", "X")).toBe(100);
    expect(parseByteCeiling(" 2000 ", "X")).toBe(2000);
  });

  it("throws on a value that is not a positive number", () => {
    // Silently reading these as "no ceiling" would disable the guard at the
    // moment the operator believed they had armed it.
    for (const bad of ["1_000_000_000", "2GB", "-1", "0", "lots"]) {
      expect(() => parseByteCeiling(bad, "VEGA_MAX_NAR_BYTES")).toThrow(/VEGA_MAX_NAR_BYTES/);
    }
  });
});

describe("planUploads size ceiling", () => {
  it("keeps a path exactly at the ceiling and drops the one above it", async () => {
    const plan = await planUploads([e("/nix/store/" + "a".repeat(32) + "-at", 100), e("/nix/store/" + "b".repeat(32) + "-over", 101)], { maxNarBytes: 100 });
    expect(plan.toUpload).toEqual(["/nix/store/" + "a".repeat(32) + "-at"]);
    expect(plan.skippedByPolicy.map((s) => s.reason)).toEqual(["too-large"]);
  });
});

describe("unmatched exclude patterns", () => {
  const big = "/nix/store/" + "a".repeat(32) + "-microvm-store-disk.erofs";

  it("reports a pattern that matched nothing", async () => {
    const plan = await planUploads([e(big)], { exclude: ["*.erofs", "*.squashfs"] });
    const matched = matchedPatterns(["*.erofs", "*.squashfs"], plan);
    expect([...matched]).toEqual(["*.erofs"]);
    expect(unmatchedPatterns(["*.erofs", "*.squashfs"], matched)).toEqual(["*.squashfs"]);
  });

  it("does not report a pattern shadowed by another that matched the same path", async () => {
    const pats = ["*.erofs", "microvm-*"];
    const plan = await planUploads([e(big)], { exclude: pats });
    expect(unmatchedPatterns(pats, matchedPatterns(pats, plan))).toEqual([]);
  });

  it("does not report a pattern matched by an earlier build", () => {
    // Accumulated across builds: a pattern aimed at one output must not warn
    // because a later output's closure lacks it.
    expect(unmatchedPatterns(["*.erofs"], new Set(["*.erofs"]))).toEqual([]);
  });

  it("never reports a full store path as matched, since matching is name-only", async () => {
    const plan = await planUploads([e(big)], { exclude: [big] });
    expect(unmatchedPatterns([big], matchedPatterns([big], plan))).toEqual([big]);
  });
});
