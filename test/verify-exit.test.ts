import { describe, it, expect } from "vitest";
import { verifyExitOk } from "../cli/commands/verify.js";
import type { VerifyResult } from "../cli/verify-core.js";

/**
 * The exit code is the only part of `vega verify` that CI reads. It lived
 * inline in the command action and so was never tested, and a revoked tenant
 * build shipped exiting 0 because one rendering branch printed success and fell
 * off the end while the JSON path exited 1.
 */
const result = (over: Partial<VerifyResult> = {}): VerifyResult => ({
  storePath: `/nix/store/${"a".repeat(32)}-hello`,
  narHash: "sha256:x",
  signature: { ok: true, keyName: "vega-cache-1", scope: "shared" },
  transparency: {
    found: true,
    index: 1,
    sthVerified: true,
    leafHashOk: true,
    inclusionOk: true,
    bindingOk: true,
    scanned: 1,
  },
  revocation: { revoked: false },
  ...over,
});

const ok = { narOk: true, narChecked: true, tenantScope: false };

describe("verifyExitOk", () => {
  it("passes a fully verified shared build", () => {
    expect(verifyExitOk(result(), ok)).toBe(true);
  });

  it("fails a revoked build on EVERY route", () => {
    const revoked = { revoked: true as const, reason: "source withdrawn" };
    // shared
    expect(verifyExitOk(result({ revocation: revoked }), ok)).toBe(false);
    // tenant scope, which is the one that shipped exiting 0
    expect(
      verifyExitOk(
        result({ revocation: revoked, signature: { ok: true, keyName: "vega-t-1", scope: "scoped" } }),
        { ...ok, tenantScope: true },
      ),
    ).toBe(false);
    // signature-only, explicitly opted into
    expect(
      verifyExitOk(
        result({
          revocation: revoked,
          signature: { ok: true, keyName: "vega-t-1", scope: "scoped" },
          transparency: { ...result().transparency, found: false },
        }),
        { ...ok, allowSignatureOnly: true },
      ),
    ).toBe(false);
  });

  it("passes a tenant build only in a tenant scope, and only with checked bytes", () => {
    const tenant = result({
      signature: { ok: true, keyName: "vega-t-1", scope: "scoped" },
      transparency: { ...result().transparency, found: false, bindingOk: false, inclusionOk: false },
    });
    expect(verifyExitOk(tenant, { ...ok, tenantScope: true })).toBe(true);
    expect(verifyExitOk(tenant, { ...ok, tenantScope: false })).toBe(false);
    expect(verifyExitOk(tenant, { ...ok, tenantScope: true, narChecked: false })).toBe(false);
  });

  it("needs the opt-in for a signature-only result outside a tenant scope", () => {
    const scoped = result({
      signature: { ok: true, keyName: "vega-t-1", scope: "scoped" },
      transparency: { ...result().transparency, found: false },
    });
    expect(verifyExitOk(scoped, ok)).toBe(false);
    expect(verifyExitOk(scoped, { ...ok, allowSignatureOnly: true })).toBe(true);
  });

  it("fails when the bytes were checked and did not match", () => {
    expect(verifyExitOk(result(), { ...ok, narOk: false })).toBe(false);
  });
});
