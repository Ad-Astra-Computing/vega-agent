import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION, compareVersions } from "./version.js";

describe("VERSION", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  it("matches package.json so the release version never drifts", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("matches the flake.nix agent version, which tags the published builder image", () => {
    // The release workflow tags/signs the GHCR image with flake.nix's
    // `agent.version`, and rejects the release if it disagrees with the tag.
    // If this drifts, `gh release create vX` fails at publish time, so pin it here.
    const flake = readFileSync(join(root, "flake.nix"), "utf8");
    const m = /pname = "vega-agent";\s*\n\s*version = "([^"]+)"/.exec(flake);
    expect(m?.[1]).toBe(VERSION);
  });
});

describe("compareVersions", () => {
  it("orders dotted numeric versions and ignores a leading v", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("v0.2.0", "0.1.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("v1.2.3", "v1.2.3")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1); // numeric, not lexical
    expect(compareVersions("1.0", "1.0.0")).toBe(0); // missing components are 0
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });
});
