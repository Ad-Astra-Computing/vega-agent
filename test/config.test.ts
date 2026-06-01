import { describe, it, expect } from "vitest";
import { parseVegaConfig, VegaConfigError } from "../src/agent/config.js";

describe("parseVegaConfig", () => {
  it("parses builds with shorthand and object forms, applying defaults", () => {
    const cfg = parseVegaConfig({
      builds: ["hello", { attr: "packages.x86_64-linux.world", systems: ["x86_64-linux", "aarch64-darwin"] }],
    });
    expect(cfg.builds).toEqual([
      { attr: "hello", systems: [] },
      { attr: "packages.x86_64-linux.world", systems: ["x86_64-linux", "aarch64-darwin"] },
    ]);
    // Defaults: reproduce off, continent published, no pseudonym.
    expect(cfg.reproduce).toBe(false);
    expect(cfg.privacy).toEqual({ continent: true, pseudonym: false });
  });

  it("honors explicit reproduce and privacy settings", () => {
    const cfg = parseVegaConfig({
      builds: ["a"],
      reproduce: true,
      privacy: { continent: false, pseudonym: true },
    });
    expect(cfg.reproduce).toBe(true);
    expect(cfg.privacy).toEqual({ continent: false, pseudonym: true });
  });

  it("parses reuse-cache (kebab-case key, default off)", () => {
    expect(parseVegaConfig({ builds: ["a"] }).reuseCache).toBe(false);
    expect(parseVegaConfig({ builds: ["a"], "reuse-cache": true }).reuseCache).toBe(true);
    expect(() => parseVegaConfig({ builds: ["a"], "reuse-cache": "yes" })).toThrow(VegaConfigError);
  });

  it("parses devShells (default empty, rejects non-string entries)", () => {
    expect(parseVegaConfig({ builds: ["a"] }).devShells).toEqual([]);
    expect(parseVegaConfig({ builds: ["a"], devShells: ["default", "rust"] }).devShells).toEqual(["default", "rust"]);
    expect(() => parseVegaConfig({ builds: ["a"], devShells: ["default", ""] })).toThrow(VegaConfigError);
    expect(() => parseVegaConfig({ builds: ["a"], devShells: "default" })).toThrow(VegaConfigError);
  });

  it("parses include/exclude matchers and allows include without builds", () => {
    const cfg = parseVegaConfig({ include: ["packages.x86_64-linux.*"], exclude: ["*.*.broken"] });
    expect(cfg.builds).toEqual([]);
    expect(cfg.include).toEqual(["packages.x86_64-linux.*"]);
    expect(cfg.exclude).toEqual(["*.*.broken"]);
    expect(() => parseVegaConfig({ include: ["bad attr!"] })).toThrow(VegaConfigError);
  });

  it("rejects a config that declares nothing to build", () => {
    expect(() => parseVegaConfig({})).toThrow(VegaConfigError);
    expect(() => parseVegaConfig({ builds: [], devShells: [], include: [] })).toThrow(VegaConfigError);
  });

  it("rejects configs with no builds", () => {
    expect(() => parseVegaConfig({})).toThrow(VegaConfigError);
    expect(() => parseVegaConfig({ builds: [] })).toThrow(VegaConfigError);
  });

  it("rejects malformed entries", () => {
    expect(() => parseVegaConfig({ builds: [""] })).toThrow(/attribute is empty/);
    expect(() => parseVegaConfig({ builds: [{ systems: ["x"] }] })).toThrow(/attr must be/);
    expect(() => parseVegaConfig({ builds: [{ attr: "a", systems: "x86_64-linux" }] })).toThrow(/systems must be/);
    expect(() => parseVegaConfig({ builds: ["a"], reproduce: "yes" })).toThrow(/reproduce must be a boolean/);
    expect(() => parseVegaConfig(null)).toThrow(/must be a mapping/);
  });
});
