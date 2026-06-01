import { describe, it, expect } from "vitest";
import { attrMatch, matchOutputs, flattenFlakeShow } from "../src/agent/outputs.js";

describe("attrMatch (linear, ReDoS-free)", () => {
  it("matches whole attribute paths, * = one component", () => {
    expect(attrMatch("packages.x86_64-linux.*", "packages.x86_64-linux.hello")).toBe(true);
    expect(attrMatch("packages.x86_64-linux.*", "packages.aarch64-darwin.hello")).toBe(false);
    expect(attrMatch("*.*", "a.b")).toBe(true);
    expect(attrMatch("*.*", "a.b.c")).toBe(false); // * does not cross dots
    expect(attrMatch("packages.*.hello", "packages.x86_64-linux.hello")).toBe(true);
    expect(attrMatch("p*k*s.*.*", "packages.x86_64-linux.hello")).toBe(true);
  });
  it("returns quickly on a pathological star-heavy glob (no backtracking blowup)", () => {
    const t0 = Date.now();
    expect(attrMatch("*".repeat(40), "a".repeat(60))).toBe(true); // single component, all wildcards
    expect(attrMatch(`${"*a".repeat(30)}*b`, "a".repeat(80))).toBe(false); // worst-case non-match
    expect(Date.now() - t0).toBeLessThan(200);
  });
});

describe("matchOutputs", () => {
  const all = [
    "packages.x86_64-linux.hello",
    "packages.x86_64-linux.world",
    "devShells.x86_64-linux.default",
    "checks.x86_64-linux.test",
  ];
  it("includes matches minus excludes", () => {
    expect(matchOutputs(all, ["packages.x86_64-linux.*"], [])).toEqual([
      "packages.x86_64-linux.hello",
      "packages.x86_64-linux.world",
    ]);
    expect(matchOutputs(all, ["*.x86_64-linux.*"], ["checks.*.*"])).toEqual([
      "packages.x86_64-linux.hello",
      "packages.x86_64-linux.world",
      "devShells.x86_64-linux.default",
    ]);
  });
});

describe("flattenFlakeShow", () => {
  it("flattens nix flake show --json to leaf attribute paths", () => {
    const tree = {
      packages: { "x86_64-linux": { hello: { type: "derivation", name: "hello-2.12" } } },
      devShells: { "x86_64-linux": { default: { type: "derivation", name: "dev" } } },
      nixosConfigurations: { theophany: { type: "nixos-configuration" } },
    };
    expect(flattenFlakeShow(tree).sort()).toEqual(
      ["devShells.x86_64-linux.default", "nixosConfigurations.theophany", "packages.x86_64-linux.hello"].sort(),
    );
  });
});
