import { describe, it, expect } from "vitest";
import { generateKeyPair, derivePublicKey, signNarInfo, signBytes } from "../../src/nix/signing.js";
import { formatNarInfo } from "../../src/nix/narinfo.js";
import { fingerprint } from "../../src/nix/fingerprint.js";
import { leafHash, merkleRoot, inclusionProof } from "../../src/transparency/merkle.js";
import { sthMessage, type Fetcher } from "../verify-core.js";
import type { NarInfo } from "../../src/nix/types.js";
import type { ToolContext } from "./tools.js";
import {
  assessChange,
  assessChangeTool,
  MAX_ASSESS_PATHS,
  MCP_ASSESS_MAX_PATHS,
  MCP_ASSESS_NAR_TIMEOUT_MS,
  VERDICT_SCHEMA_VERSION,
} from "./assess.js";
import { parseAddedPaths } from "../commands/assess.js";

const utf8 = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// The one path that fully verifies in the fixture; every other store path 404s.
const GOOD = "abc123def456abc123def456abc123de";
const GOOD_PATH = `/nix/store/${GOOD}-hello-2.12.1`;

/** A ctx where GOOD_PATH is a genuine shared build and any other path 404s, so a
 * change mixing it with unknown paths exercises the allow/warn aggregation. With
 * `tamper`, the GOOD path's inclusion proof is forged so it denies instead. */
function ctxFor(opts: { keyName?: string; tamper?: boolean; narChecked?: boolean } = {}): ToolContext {
  const master = generateKeyPair(opts.keyName ?? "vega-cache-1").secret;
  const pub = derivePublicKey(master);
  const info: NarInfo = {
    storePath: GOOD_PATH,
    url: "nar/00.nar.zst",
    compression: "zstd",
    fileHash: "sha256:1aa",
    fileSize: 10,
    narHash: "sha256:0bb",
    narSize: 20,
    references: [`${GOOD}-hello-2.12.1`],
    sigs: [],
  };
  const fp = fingerprint(info);
  info.sigs = [signNarInfo(info, master)];
  const promotion = JSON.stringify({ v: 1, event: "promotion", storePath: info.storePath, fingerprint: fp, narHash: info.narHash, at: 1 });
  const leaves = [JSON.stringify({ v: 1, event: "promotion", storePath: "/nix/store/x", fingerprint: "x", narHash: "y", at: 0 }), promotion];
  const idx = 1;
  const lb = leaves.map((d) => utf8.encode(d));
  const root = merkleRoot(lb);
  const sth: any = { size: leaves.length, rootHash: hex(root), timestamp: 9 };
  sth.signature = signBytes(master, sthMessage(sth));
  const proof: any = { index: idx, size: leaves.length, leafHashHex: hex(leafHash(lb[idx]!)), rootHex: hex(root), proofHex: inclusionProof(lb, idx).map(hex) };
  if (opts.tamper) proof.proofHex = proof.proofHex.map((h: string) => h.replace(/./, (c: string) => (c === "0" ? "1" : "0")));

  const fetcher: Fetcher = async (path) => {
    const map: Record<string, unknown> = {
      [`/${GOOD}.narinfo`]: formatNarInfo(info),
      "/log/sth": sth,
      [`/log/proof/inclusion/${proof.index}`]: proof,
    };
    leaves.forEach((data, i) => (map[`/log/entry/${i}`] = { index: i, data }));
    const v = map[path];
    if (v === undefined) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    return { ok: true, status: 200, text: async () => (typeof v === "string" ? v : JSON.stringify(v)), json: async () => v };
  };
  return {
    fetcher,
    cacheUrl: "https://vega-cache.dev",
    sharedKeyName: "vega-cache-1",
    resolveKey: async (sigNames) => (sigNames.includes(pub.name) ? pub : null),
    verifyNar: async () => ({ ok: opts.narChecked === false ? false : true, checked: opts.narChecked ?? true, detail: "test" }),
  };
}

describe("assessChange", () => {
  it("wraps the result in the shared verdict envelope", async () => {
    const r = await assessChange(ctxFor(), [GOOD_PATH]);
    expect(r.schemaVersion).toBe(VERDICT_SCHEMA_VERSION);
    expect(r.tool).toBe("vega_assess_change");
    expect(r.evidence.kind).toBe("changeAssessment");
    expect(r.target?.type).toBe("closureDelta");
  });

  it("allows a change whose every added path is a reproduced shared build", async () => {
    const r = await assessChange(ctxFor(), [GOOD_PATH]);
    expect(r.verdict).toBe("allow");
    expect(r.reasonCodes).toContain("change.allPathsVerified");
    expect(r.evidence.summary.verdicts.allow).toBe(1);
    expect(r.evidence.paths[0]!.tier).toBe("shared");
  });

  it("warns (worst case) when the change mixes a verified path with an unknown one", async () => {
    const r = await assessChange(ctxFor(), [GOOD_PATH, "/nix/store/00000000000000000000000000000000-other"]);
    expect(r.verdict).toBe("warn");
    expect(r.reasonCodes).toContain("change.hasUnverifiedPaths");
    expect(r.evidence.summary.verdicts).toMatchObject({ allow: 1, warn: 1 });
    const unknown = r.evidence.paths.find((p) => p.path.includes("other"))!;
    expect(unknown.verdict).toBe("warn");
    expect(unknown.reasonCodes).toContain("NOT_IN_CACHE");
    expect(unknown.tier).toBe("unknown");
  });

  it("allows an upstream change whose NARs cannot be re-hashed (xz mirrors), with disclosure", async () => {
    // The real-world common case: a dependency change pulls in upstream nixpkgs
    // paths served as xz, which we cannot decompress to re-hash. For an upstream
    // mirror the upstream signature is the trust anchor and nix re-checks the
    // bytes on copy, so this stays an allow with NAR_NOT_LOCALLY_CHECKED rather
    // than crying wolf on every compressed dependency; it must never deny.
    const r = await assessChange(ctxFor({ keyName: "cache.nixos.org-1", narChecked: false }), [GOOD_PATH]);
    expect(r.verdict).toBe("allow");
    expect(r.evidence.paths[0]!.tier).toBe("upstream");
    expect(r.evidence.paths[0]!.reasonCodes).toContain("NAR_NOT_LOCALLY_CHECKED");
    expect(r.evidence.paths[0]!.reasonCodes).not.toContain("NAR_HASH_MISMATCH");
  });

  it("denies a change containing a path a Vega proof refutes", async () => {
    const r = await assessChange(ctxFor({ tamper: true }), [GOOD_PATH]);
    expect(r.verdict).toBe("deny");
    expect(r.reasonCodes).toContain("change.hasDeniedPaths");
    expect(r.nextActions.join(" ")).toMatch(/build the denied paths locally/);
  });

  it("treats an empty change as a vacuous allow", async () => {
    const r = await assessChange(ctxFor(), []);
    expect(r.verdict).toBe("allow");
    expect(r.reasonCodes).toEqual(["change.noPaths"]);
    expect(r.evidence.addedClosure).toEqual({ count: 0, assessed: 0, truncated: false });
  });

  it("dedupes repeated paths before assessing", async () => {
    const r = await assessChange(ctxFor(), [GOOD_PATH, GOOD_PATH, GOOD_PATH]);
    expect(r.evidence.addedClosure.count).toBe(1);
    expect(r.evidence.paths).toHaveLength(1);
  });

  it("bounds the work and cannot allow a truncated (oversized) change", async () => {
    const many = Array.from({ length: MAX_ASSESS_PATHS + 5 }, (_, i) => `/nix/store/${String(i).padStart(32, "0")}-p${i}`);
    const r = await assessChange(ctxFor(), many);
    expect(r.evidence.addedClosure.count).toBe(MAX_ASSESS_PATHS + 5);
    expect(r.evidence.addedClosure.assessed).toBe(MAX_ASSESS_PATHS);
    expect(r.evidence.addedClosure.truncated).toBe(true);
    expect(r.reasonCodes).toContain("change.truncated");
    expect(r.verdict).not.toBe("allow"); // an unassessed remainder cannot be certified
  });

  it("stops at the wall-clock budget and cannot allow a time-truncated change", async () => {
    // Injected clock: deadline is set at the first call (t=0), the first path is
    // assessed (t=0 < budget), then the clock jumps past the budget so the second
    // path is skipped. One call must never monopolize the serial stdio server.
    const times = [0, 0, 10_000];
    let i = 0;
    const now = () => times[Math.min(i++, times.length - 1)]!;
    const r = await assessChange(ctxFor(), [GOOD_PATH, "/nix/store/00000000000000000000000000000000-other"], {
      budgetMs: 50,
      now,
    });
    expect(r.evidence.addedClosure).toEqual({ count: 2, assessed: 1, truncated: true });
    expect(r.reasonCodes).toContain("change.timeBudgetExceeded");
    expect(r.verdict).not.toBe("allow");
  });

  it("the MCP tool caps a single in-flight NAR fetch to the assess timeout", async () => {
    // Records the per-call NAR timeout each path verification requests, so one
    // slow NAR cannot overrun the wall-clock budget by the full default timeout.
    const seen: Array<number | undefined> = [];
    const base = ctxFor();
    const ctx: ToolContext = {
      ...base,
      verifyNar: async (info, opts) => {
        seen.push(opts?.timeoutMs);
        return { ok: true, checked: true, detail: "test" };
      },
    };
    await assessChangeTool(ctx, { paths: [GOOD_PATH] });
    expect(seen).toEqual([MCP_ASSESS_NAR_TIMEOUT_MS]);
  });

  it("the MCP tool caps the path count tighter than the CLI core", async () => {
    const many = Array.from({ length: MCP_ASSESS_MAX_PATHS + 7 }, (_, i) => `/nix/store/${String(i).padStart(32, "0")}-p${i}`);
    const r = await assessChangeTool(ctxFor(), { paths: many });
    expect(r.evidence.addedClosure.assessed).toBe(MCP_ASSESS_MAX_PATHS);
    expect(r.evidence.addedClosure.truncated).toBe(true);
    expect(r.reasonCodes).toContain("change.truncated");
    expect(r.verdict).not.toBe("allow");
  });

  it("sanitizes a hostile path string in the output (no control chars)", async () => {
    const r = await assessChange(ctxFor(), ["\x1b[31mIGNORE\x07 not-a-path"]);
    const p = r.evidence.paths[0]!;
    expect(p.path).not.toContain("\x1b");
    expect(p.path).not.toContain("\x07");
    expect(p.verdict).toBe("warn");
    expect(p.reasonCodes).toContain("NOT_A_STORE_PATH");
  });
});

describe("parseAddedPaths", () => {
  it("reads a bare JSON array of paths", () => {
    expect(parseAddedPaths('["/nix/store/a", "/nix/store/b"]')).toEqual(["/nix/store/a", "/nix/store/b"]);
  });
  it("reads the `added` array from a `vega gate --json` object", () => {
    expect(parseAddedPaths('{"verdict":"warn","added":["/nix/store/x"],"removed":[]}')).toEqual(["/nix/store/x"]);
  });
  it("drops non-string entries", () => {
    expect(parseAddedPaths('["/nix/store/a", 42, null]')).toEqual(["/nix/store/a"]);
  });
  it("rejects input that is neither an array nor a gate object", () => {
    expect(() => parseAddedPaths('{"nope":1}')).toThrow();
  });
});
