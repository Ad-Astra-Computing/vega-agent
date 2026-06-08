import { describe, it, expect } from "vitest";
import type { ClosureDelta, ClosurePath } from "../src/nix/closure.js";
import { assessClosureGate, DEFAULT_GATE_POLICY } from "../src/agent/closure-gate.js";

const p = (c: string, name: string, narSize: number): ClosurePath => ({
  path: `/nix/store/${c.repeat(32)}-${name}`,
  hash: c.repeat(32),
  name,
  narSize,
  references: [],
});

const delta = (added: ClosurePath[], removed: ClosurePath[]): ClosureDelta => {
  const addedNarSize = added.reduce((n, x) => n + x.narSize, 0);
  const removedNarSize = removed.reduce((n, x) => n + x.narSize, 0);
  return {
    added,
    removed,
    baseCount: removed.length,
    currentCount: added.length,
    addedNarSize,
    removedNarSize,
    netNarSize: addedNarSize - removedNarSize,
  };
};

describe("assessClosureGate", () => {
  it("allows an unchanged closure", () => {
    const r = assessClosureGate(delta([], []), 1000, DEFAULT_GATE_POLICY);
    expect(r.verdict).toBe("allow");
    expect(r.reasonCodes).toEqual([]);
  });

  it("allows removals-only (with an informational code)", () => {
    const r = assessClosureGate(delta([], [p("1", "old", 50)]), 1000, DEFAULT_GATE_POLICY);
    expect(r.verdict).toBe("allow");
    expect(r.reasonCodes).toContain("closure.removed_paths");
  });

  it("warns when a few new (in-threshold) paths enter the closure", () => {
    const r = assessClosureGate(delta([p("0", "a", 5), p("a", "b", 5)], []), 100000, DEFAULT_GATE_POLICY);
    expect(r.verdict).toBe("warn");
    expect(r.reasonCodes).toContain("closure.new_paths");
    expect(r.newPathCount).toBe(2);
  });

  it("denies a large NAR-size delta", () => {
    const r = assessClosureGate(delta([p("0", "huge", 300)], []), 1000, DEFAULT_GATE_POLICY);
    expect(r.verdict).toBe("deny"); // +30% > 20%
    expect(r.reasonCodes).toContain("closure.narsize_delta_deny");
  });

  it("denies when too many new paths enter", () => {
    const added = Array.from({ length: 26 }, (_, i) => p("0", `pkg${i}`, 1));
    // distinct paths: vary the name so paths differ
    const r = assessClosureGate(delta(added.map((x, i) => ({ ...x, path: `/nix/store/${"0".repeat(32)}-pkg${i}` })), []), 1_000_000, DEFAULT_GATE_POLICY);
    expect(r.verdict).toBe("deny");
    expect(r.reasonCodes).toContain("closure.new_path_count_deny");
  });

  it("denies an uncached new path only when cachePolicy=deny", () => {
    const d = delta([p("0", "a", 1)], []);
    const off = assessClosureGate(d, 1_000_000, { ...DEFAULT_GATE_POLICY, cachePolicy: "off" }, 1);
    expect(off.verdict).toBe("warn"); // cache lookup skipped; just the new-path warn
    expect(off.reasonCodes).not.toContain("closure.new_uncached_paths");
    const deny = assessClosureGate(d, 1_000_000, { ...DEFAULT_GATE_POLICY, cachePolicy: "deny" }, 1);
    expect(deny.verdict).toBe("deny");
    expect(deny.reasonCodes).toContain("closure.new_uncached_paths");
  });

  it("takes the highest verdict across all triggers", () => {
    const r = assessClosureGate(delta([p("0", "huge", 1000)], [p("1", "x", 1)]), 100, DEFAULT_GATE_POLICY);
    expect(r.verdict).toBe("deny");
  });

  it("keeps the size percent finite when the baseline is empty (no Infinity)", () => {
    const r = assessClosureGate(delta([p("0", "a", 5), p("a", "b", 5)], []), 0, DEFAULT_GATE_POLICY);
    expect(Number.isFinite(r.sizeDeltaPercent)).toBe(true);
    expect(r.sizeDeltaPercent).toBe(0);
    expect(r.verdict).toBe("warn"); // driven by the new-path triggers, not size
  });

  it("triggers on ADDED size, so a big removal cannot mask a big new dependency", () => {
    // Net NAR size SHRINKS (removed 2000 > added 1000), but 1000 new bytes were
    // pulled in: that is +100% added vs a 1000-byte baseline, so it must deny.
    const r = assessClosureGate(delta([p("0", "newbig", 1000)], [p("1", "oldbigger", 2000)]), 1000, DEFAULT_GATE_POLICY);
    expect(r.verdict).toBe("deny");
    expect(r.reasonCodes).toContain("closure.narsize_delta_deny");
    expect(r.sizeDeltaPercent).toBe(100);
  });
});
