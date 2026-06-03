import { describe, it, expect } from "vitest";
import { buildArgs, rebuildArgs, parseRebuild } from "../src/agent/diff.js";

describe("vega diff arg building", () => {
  it("terminates option parsing with -- before the installable", () => {
    expect(buildArgs(".#pkg")).toEqual(["build", "--no-link", "--print-out-paths", "--", ".#pkg"]);
    expect(rebuildArgs(".#pkg")).toEqual([
      "build",
      "--rebuild",
      "--keep-failed",
      "-L",
      "--no-link",
      "--",
      ".#pkg",
    ]);
  });

  it("refuses an installable that looks like a flag", () => {
    expect(() => buildArgs("--store")).toThrow(/looks like a flag/);
    expect(() => rebuildArgs("-L")).toThrow(/looks like a flag/);
  });
});

describe("parseRebuild", () => {
  it("reports reproducible on a clean exit", () => {
    expect(parseRebuild("", 0)).toEqual({ reproducible: true });
    expect(parseRebuild("anything", 0).reproducible).toBe(true);
  });

  it("extracts both paths from a non-determinism mismatch", () => {
    const log =
      "error: derivation '/nix/store/aaa.drv' may not be deterministic: " +
      "output '/nix/store/0fffffffffffffffffffffffffffffff-pkg' differs from " +
      "'/nix/store/0fffffffffffffffffffffffffffffff-pkg.check'";
    const r = parseRebuild(log, 1);
    expect(r.reproducible).toBe(false);
    expect(r.checkPath).toBe("/nix/store/0fffffffffffffffffffffffffffffff-pkg.check");
    expect(r.outPath).toBe("/nix/store/0fffffffffffffffffffffffffffffff-pkg");
  });

  it("treats a non-zero exit with no .check path as a build error, not a divergence", () => {
    const r = parseRebuild("error: builder for '/nix/store/x.drv' failed with exit code 2", 1);
    expect(r.reproducible).toBe(false);
    expect(r.checkPath).toBeUndefined();
    expect(r.outPath).toBeUndefined();
  });

  it("does not mistake a stray 'differs' for a divergence without a kept .check path", () => {
    const r = parseRebuild("note: the documentation differs slightly", 1);
    expect(r.checkPath).toBeUndefined();
  });
});
