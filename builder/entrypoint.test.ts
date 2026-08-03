import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The sandbox decision tree lives in bash (builder/entrypoint.sh) and is tested
// in bash (entrypoint.test.sh, which stubs the probe). This wrapper runs that
// suite under `npm test` so the one test entrypoint covers it too. The build
// also shellchecks entrypoint.sh via writeShellApplication in flake.nix.
describe("builder entrypoint", () => {
  it("resolve_sandbox decision tree (bash)", () => {
    const script = fileURLToPath(new URL("./entrypoint.test.sh", import.meta.url));
    const out = execFileSync("bash", [script], { encoding: "utf8" });
    expect(out).toContain("all entrypoint sandbox tests passed");
  });

  it("boot shim: fast path, volume self-seed and fail-loud cases (bash)", () => {
    const script = fileURLToPath(new URL("./bootstrap.test.sh", import.meta.url));
    // Capture stderr too: the suite reports a skipped busybox pass there, and
    // in CI a skip must FAIL (the busybox pass is the regression lock for the
    // defect class that once shipped broken while GNU-tool tests stayed green).
    const out = execFileSync("bash", [script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(out).toContain("all bootstrap tests passed");
    if (process.env.CI) {
      expect(out).toContain("ok(busybox):");
    }
  });
});
