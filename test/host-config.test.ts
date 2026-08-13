import { describe, it, expect } from "vitest";
import { hostConfigBlock, findSubstituterMismatch, isNixPublicKey, isSubstituterPath, tenantKeyNames } from "../src/agent/substituter.js";

// Born from a real deployment: a host substituted from the bare control-plane
// URL for ten days. The root answered /nix-cache-info with 200 (it is the
// shared-tier cache), so Nix accepted it, then missed every tenant path with
// no way to tell a misconfigured cache from a cold one. The host rebuilt its
// full closure on every CI run until it hit the time cap.

describe("the host config block printed after a push", () => {
  const key = "vega-jasonodoom-nixos-configs-1:OrD5r55n02TvdLMeFppwnTH5nciTy44UnxwC8kQuKqE=";

  it("prints paste-ready nix.conf lines for the tenant substituter", () => {
    const lines = hostConfigBlock(
      "https://vega-cache.dev",
      "https://vega-cache.dev/tenant/jasonodoom/nixos-configs",
      key,
    );
    expect(lines).toContain("  extra-substituters = https://vega-cache.dev/tenant/jasonodoom/nixos-configs");
    expect(lines).toContain(`  extra-trusted-public-keys = ${key}`);
  });

  it("joins a server-relative substituter path onto the control plane", () => {
    const lines = hostConfigBlock("https://vega-cache.dev", "/tenant/owner:583231", "vega-owner-583231-1:aa==");
    expect(lines).toContain("  extra-substituters = https://vega-cache.dev/tenant/owner:583231");
  });

  it("tolerates a trailing slash on the control plane", () => {
    const lines = hostConfigBlock("https://vega-cache.dev/", "/tenant/o/r", "vega-o-r-1:aa==");
    expect(lines).toContain("  extra-substituters = https://vega-cache.dev/tenant/o/r");
  });

  it("says plainly that the bare control-plane URL is not the tenant cache", () => {
    const text = hostConfigBlock("https://vega-cache.dev", "/tenant/o/r", "vega-o-r-1:aa==").join("\n");
    expect(text).toMatch(/shared tier/);
  });
});

describe("detecting a tenant key pointed at the wrong substituter", () => {
  const cp = "https://vega-cache.dev";
  const tenantKey = "vega-jasonodoom-nixos-configs-1:OrD5r55n02TvdLMeFppwnTH5nciTy44UnxwC8kQuKqE=";
  const sharedKey = "vega-cache-1:cPagS1g69NQGwlBCyTTeKav/NhlN8a7ixuj2uLOkHrQ=";

  it("flags a tenant key served only by the bare root, the ten-day failure", () => {
    const m = findSubstituterMismatch([cp], [tenantKey], cp);
    expect(m).toMatch(/shared tier/);
    expect(m).toMatch(/vega-jasonodoom-nixos-configs-1/);
  });

  it("flags a tenant key with no Vega substituter at all", () => {
    const m = findSubstituterMismatch(["https://cache.nixos.org"], [tenantKey], cp);
    expect(m).toMatch(/no .*\/tenant\//);
  });

  it("accepts a tenant key with its tenant substituter configured", () => {
    expect(findSubstituterMismatch([cp, `${cp}/tenant/jasonodoom/nixos-configs`], [tenantKey], cp)).toBeNull();
  });

  it("accepts a personalized /u/ view substituter as serving tenant content", () => {
    expect(findSubstituterMismatch([`${cp}/u/sometoken`], [tenantKey], cp)).toBeNull();
  });

  it("does not mistake the shared key for a tenant key", () => {
    expect(findSubstituterMismatch([cp], [sharedKey], cp)).toBeNull();
  });

  it("does not mistake a view key for a tenant key", () => {
    expect(findSubstituterMismatch([cp], ["vega-view-ab12-1:aa=="], cp)).toBeNull();
  });

  it("ignores non-Vega keys entirely", () => {
    expect(findSubstituterMismatch([cp], ["cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="], cp)).toBeNull();
  });

  it("normalizes trailing slashes on both sides", () => {
    expect(findSubstituterMismatch([`${cp}/tenant/o/r/`], [tenantKey], `${cp}/`)).toBeNull();
    expect(findSubstituterMismatch([`${cp}/`], [tenantKey], cp)).toMatch(/shared tier/);
  });
});

describe("validating server-supplied values before printing them", () => {
  // The control plane is named by a stored credential, and these strings are
  // printed to a terminal and pasted into host configs. report.ts already
  // holds this line for verdicts; the key and substituter hold it too.
  const ESC = String.fromCharCode(27);

  it("accepts a well-formed Nix public key", () => {
    expect(isNixPublicKey("vega-jasonodoom-nixos-configs-1:OrD5r55n02TvdLMeFppwnTH5nciTy44UnxwC8kQuKqE=")).toBe(true);
  });

  it("rejects a key carrying newlines or terminal escapes", () => {
    expect(isNixPublicKey("vega-x-1:aa==\nextra-substituters = https://evil.example")).toBe(false);
    expect(isNixPublicKey("vega-x-1:" + ESC + "[31maa==")).toBe(false);
    expect(isNixPublicKey("")).toBe(false);
    expect(isNixPublicKey("no-colon")).toBe(false);
  });

  it("accepts the substituter paths the server actually returns", () => {
    expect(isSubstituterPath("/tenant/jasonodoom/nixos-configs")).toBe(true);
    expect(isSubstituterPath("/tenant/owner:583231")).toBe(true);
  });

  it("rejects a substituter that is absolute, empty or carries escapes", () => {
    expect(isSubstituterPath("https://evil.example/tenant/x")).toBe(false);
    expect(isSubstituterPath("")).toBe(false);
    expect(isSubstituterPath("/tenant/x" + ESC + "[2Jy")).toBe(false);
    expect(isSubstituterPath("/tenant/x y")).toBe(false);
  });
});

describe("naming the tenant keys a nix config trusts", () => {
  it("names tenant keys and only tenant keys", () => {
    expect(
      tenantKeyNames([
        "vega-cache-1:aa==",
        "vega-view-ab12-1:aa==",
        "vega-o-r-1:aa==",
        "cache.nixos.org-1:aa==",
      ]),
    ).toEqual(["vega-o-r-1"]);
  });
});
