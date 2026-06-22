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
});
