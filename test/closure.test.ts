import { describe, it, expect } from "vitest";
import { parseClosure, diffClosures, serializeBaseline, parseBaseline } from "../src/nix/closure.js";

const H = (c: string) => c.repeat(32); // a valid 32-char nixbase32 hash (0/1/a are all in-alphabet)
const P = (c: string, name: string) => `/nix/store/${H(c)}-${name}`;
const hello = P("0", "hello-2.12.1");
const glibc = P("1", "glibc-2.40");
const newdep = P("a", "evil-1.0");

describe("parseClosure", () => {
  it("parses the path-keyed object form, normalizes, and sorts by path", () => {
    const json = {
      [glibc]: { narSize: 30, references: [glibc] },
      [hello]: { narSize: 10, references: [glibc] },
    };
    const c = parseClosure(json);
    expect(c.map((p) => p.path)).toEqual([hello, glibc]); // sorted (0 < 1)
    expect(c[0]).toMatchObject({ name: "hello-2.12.1", hash: H("0"), narSize: 10, references: [glibc] });
  });

  it("parses the array form too", () => {
    const json = [{ path: hello, narSize: 10, references: [] }];
    expect(parseClosure(json).map((p) => p.path)).toEqual([hello]);
  });

  it("defaults a missing narSize to 0 and missing references to []", () => {
    const c = parseClosure({ [hello]: {} });
    expect(c[0]!.narSize).toBe(0);
    expect(c[0]!.references).toEqual([]);
  });

  it("throws on a non-store-path entry (a closure must be addressable)", () => {
    expect(() => parseClosure({ "/etc/passwd": { narSize: 1 } })).toThrow();
  });

  it("throws on a non-array, non-object root", () => {
    expect(() => parseClosure("nope")).toThrow();
    expect(() => parseClosure(null)).toThrow();
  });

  it("throws on an array entry with no path (never silently drops it)", () => {
    expect(() => parseClosure([{ narSize: 10 }])).toThrow();
  });

  it("dedupes a repeated path so counts are not inflated", () => {
    const c = parseClosure([
      { path: hello, narSize: 10 },
      { path: hello, narSize: 10 },
    ]);
    expect(c).toHaveLength(1);
  });

  it("uses the object KEY as the path, even if the value carries a conflicting path field", () => {
    const c = parseClosure({ [hello]: { path: glibc, narSize: 10 } } as Record<string, unknown>);
    expect(c[0]!.path).toBe(hello); // the authoritative key wins
  });
});

describe("diffClosures", () => {
  it("reports added and removed paths and the nar-size deltas", () => {
    const base = parseClosure({ [hello]: { narSize: 10 }, [glibc]: { narSize: 30 } });
    const current = parseClosure({ [hello]: { narSize: 10 }, [newdep]: { narSize: 50 } });
    const d = diffClosures(base, current);
    expect(d.added.map((p) => p.path)).toEqual([newdep]); // glibc removed, evil added
    expect(d.removed.map((p) => p.path)).toEqual([glibc]);
    expect(d.addedNarSize).toBe(50);
    expect(d.removedNarSize).toBe(30);
    expect(d.netNarSize).toBe(20);
    expect(d.baseCount).toBe(2);
    expect(d.currentCount).toBe(2);
  });

  it("is empty when the closures match", () => {
    const c = parseClosure({ [hello]: { narSize: 10 } });
    const d = diffClosures(c, c);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.netNarSize).toBe(0);
  });
});

describe("baseline serialize/parse", () => {
  it("round-trips and is path-sorted and diff-friendly", () => {
    const c = parseClosure({ [glibc]: { narSize: 30 }, [hello]: { narSize: 10 } });
    const text = serializeBaseline(c);
    expect(text).toBe(`10 ${hello}\n30 ${glibc}\n`); // sorted by path, one line each
    const back = parseBaseline(text);
    expect(back.map((p) => p.path)).toEqual([hello, glibc]);
    expect(back[0]).toMatchObject({ narSize: 10, name: "hello-2.12.1" });
  });

  it("throws on a corrupt baseline (non-numeric/negative size or no space), failing closed", () => {
    expect(() => parseBaseline(`abc ${hello}`)).toThrow();
    expect(() => parseBaseline(hello)).toThrow(); // no "<size> " prefix
    expect(() => parseBaseline(`-5 ${hello}`)).toThrow();
  });

  it("dedupes repeated baseline lines", () => {
    expect(parseBaseline(`10 ${hello}\n10 ${hello}\n`)).toHaveLength(1);
  });
});
