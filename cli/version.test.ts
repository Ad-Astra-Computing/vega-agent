import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION, compareVersions } from "./version.js";

describe("VERSION", () => {
  it("matches package.json so the release version never drifts", () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
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
