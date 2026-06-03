import { describe, it, expect } from "vitest";
import { isTenantScope } from "../cli/commands/verify.js";

describe("isTenantScope (tenant-only verify gate)", () => {
  it("accepts exact tenant substituter paths", () => {
    expect(isTenantScope("https://vega-cache.dev/tenant/jasonodoom/nixos-configs")).toBe(true);
    expect(isTenantScope("https://vega-cache.dev/tenant/jasonodoom/nixos-configs/")).toBe(true); // trailing slash
    expect(isTenantScope("https://vega-cache.dev/tenant/owner:583231")).toBe(true); // owner-push namespace
  });

  it("rejects the shared root and anything that is not an exact tenant path", () => {
    expect(isTenantScope("https://vega-cache.dev")).toBe(false); // shared root: never auto-fetch a key
    expect(isTenantScope("https://vega-cache.dev/")).toBe(false);
    expect(isTenantScope("https://evil.example/foo/tenant/bar")).toBe(false); // loose match must not pass
    expect(isTenantScope("https://vega-cache.dev/tenant/onlyowner")).toBe(false); // missing repo
    expect(isTenantScope("https://vega-cache.dev/tenant/owner/repo/extra")).toBe(false); // too deep
    expect(isTenantScope("not a url")).toBe(false);
  });
});
