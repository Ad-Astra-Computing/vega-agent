import { describe, it, expect } from "vitest";
import { planUploads } from "../src/agent/upload-plan.js";

// 32-char store hashes (nixbase32 alphabet) for three paths.
const A = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-a";
const B = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-b";
const C = "/nix/store/cccccccccccccccccccccccccccccccc-c";

/** A fake cache: HEAD a `<hash>.narinfo` returns 200 if the hash is in `present`
 * for that base URL, else 404. Lets us simulate upstream + tenant membership. */
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
    expect(plan.skippedResume).toEqual([]);
  });

  it("drops paths the upstream cache already serves", async () => {
    const up = "https://cache.nixos.org";
    const plan = await planUploads([A, B, C], { upstreamUrl: up }, fakeCache({ [up]: ["a".repeat(32)] }));
    expect(plan.skippedUpstream).toEqual([A]);
    expect(plan.toUpload).toEqual([B, C]);
  });

  it("resumes: drops paths already in this tenant from a prior run", async () => {
    const tenant = "https://vega-cache.dev/tenant/org/repo";
    const plan = await planUploads([A, B, C], { resumeUrl: tenant }, fakeCache({ [tenant]: ["b".repeat(32)] }));
    expect(plan.skippedResume).toEqual([B]);
    expect(plan.toUpload).toEqual([A, C]);
  });

  it("applies upstream first, then resumes over the remainder", async () => {
    const up = "https://cache.nixos.org";
    const tenant = "https://vega-cache.dev/tenant/org/repo";
    const plan = await planUploads(
      [A, B, C],
      { upstreamUrl: up, resumeUrl: tenant },
      fakeCache({ [up]: ["a".repeat(32)], [tenant]: ["b".repeat(32)] }),
    );
    expect(plan.skippedUpstream).toEqual([A]);
    expect(plan.skippedResume).toEqual([B]); // resume probes only the post-upstream set
    expect(plan.toUpload).toEqual([C]);
  });

  it("uploads a path on a probe error (never silently dropped)", async () => {
    const tenant = "https://vega-cache.dev/tenant/org/repo";
    const failing = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    const plan = await planUploads([A], { resumeUrl: tenant }, failing);
    expect(plan.toUpload).toEqual([A]);
    expect(plan.skippedResume).toEqual([]);
  });
});
