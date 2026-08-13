import { describe, it, expect } from "vitest";
import { unresolvableProvenance } from "../src/agent/repro-failure.js";

describe("classifying why a reproduction failed", () => {
  it("reads the evaluator's own error, not something a build printed", () => {
    // A flake can write anything to stderr, including nix's wording. Retirement
    // is shared across everyone attesting that output, so the judgement has to
    // come from a line nix marked as an error rather than from build output.
    expect(unresolvableProvenance("building '/nix/store/x.drv'...\ndoes not provide attribute\n")).toBe(false);
    expect(unresolvableProvenance("trace: does not provide attribute")).toBe(false);
    expect(
      unresolvableProvenance("error: flake 'github:o/r' does not provide attribute 'packages.x86_64-linux.gone'"),
    ).toBe(true);
  });

  // This classification retires a candidate on the first report, so it has to be
  // narrow: the cost of calling a transient failure permanent is a healthy
  // candidate nobody ever builds again.
  it("recognises provenance that cannot name the output", () => {
    expect(
      unresolvableProvenance(
        "error: flake 'github:o/r/abc' does not provide attribute " +
          "'packages.x86_64-linux.nixosConfigurations.congo.config.system.build.toplevel'",
      ),
    ).toBe(true);
  });

  it("does not treat a build failure as permanent", () => {
    expect(unresolvableProvenance("error: builder for '/nix/store/x.drv' failed with exit code 1")).toBe(false);
  });

  it("does not treat a fetch or network failure as permanent", () => {
    expect(unresolvableProvenance("error: unable to download 'https://cache.nixos.org': Couldn't connect")).toBe(false);
    expect(unresolvableProvenance("error: cannot fetch input 'github:o/r': timeout")).toBe(false);
  });

  it("does not treat a disk or memory failure as permanent", () => {
    expect(unresolvableProvenance("error: writing to file: No space left on device")).toBe(false);
  });
});
