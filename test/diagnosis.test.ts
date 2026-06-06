import { describe, it, expect } from "vitest";
import { classifyDiff } from "../src/diagnosis/classify.js";
import { diagnose } from "../src/diagnosis/report.js";

describe("classifyDiff", () => {
  it("flags an embedded build path", () => {
    const diff = `
@@ strings differ @@
- built in /build/foo-1.2.3/src
+ built in /build/foo-1.2.3-check/src
`;
    const ranked = classifyDiff(diff);
    expect(ranked[0]!.cause.id).toBe("build-path");
    expect(ranked[0]!.evidence.length).toBeGreaterThan(0);
  });

  it("flags a Go build id", () => {
    const ranked = classifyDiff("Go build ID: abc123 vs Go build ID: def456");
    expect(ranked.map((r) => r.cause.id)).toContain("go-buildid");
  });

  it("flags embedded timestamps", () => {
    const ranked = classifyDiff("mtime: 2021-06-27 12:00:01 GMT differs");
    expect(ranked[0]!.cause.id).toBe("timestamps");
  });

  it("ranks by number of matching signatures and returns evidence lines", () => {
    const diff = "value __DATE__ embedded\nanother __TIME__ here";
    const ranked = classifyDiff(diff);
    expect(ranked[0]!.cause.id).toBe("date-macros");
    expect(ranked[0]!.evidence).toContain("value __DATE__ embedded");
  });

  it("returns an empty ranking when nothing matches", () => {
    expect(classifyDiff("these two lines are byte-identical")).toEqual([]);
  });
});

describe("diagnose (programmatic, no LLM)", () => {
  it("turns a divergence diff into named causes with standard fixes", () => {
    const d = diagnose({
      storePath: "/nix/store/aaa-foo-1.0",
      diff: "built in /build/foo and mtime 2021-06-27 12:00:01 GMT",
    });
    expect(d.storePath).toBe("/nix/store/aaa-foo-1.0");
    const ids = d.findings.map((f) => f.causeId);
    expect(ids).toContain("build-path");
    expect(ids).toContain("timestamps");
    const buildPath = d.findings.find((f) => f.causeId === "build-path")!;
    expect(buildPath.fix).toMatch(/BUILD_PATH_PREFIX_MAP|build directory/i);
    expect(buildPath.evidence.length).toBeGreaterThan(0);
    expect(d.reproducible).toBe(false);
  });

  it("reports no known cause when the diff matches nothing", () => {
    const d = diagnose({ diff: "two identical lines" });
    expect(d.findings).toEqual([]);
    expect(d.summary).toMatch(/no known/i);
  });
});
