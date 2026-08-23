import { describe, it, expect } from "vitest";
import { generateKeyPair, derivePublicKey, signNarInfo, signBytes } from "../src/nix/signing.js";
import { formatNarInfo } from "../src/nix/narinfo.js";
import { fingerprint } from "../src/nix/fingerprint.js";
import { leafHash, merkleRoot, inclusionProof } from "../src/transparency/merkle.js";
import type { NarInfo } from "../src/nix/types.js";
import {
  verifyBuild,
  fullyVerified,
  sthMessage,
  type Fetcher,
  type Sth,
  type InclusionProof,
} from "./verify-core.js";

const utf8 = new TextEncoder();
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

// A fake build: a signed narinfo, a transparency log containing its promotion
// leaf among decoys, a signed tree head, and an inclusion proof. Everything is
// produced with the real primitives so the test exercises the genuine crypto.
function scenario(
  opts: { keyName?: string; tamper?: (f: Fixture) => void; revocations?: (f: Fixture) => unknown[] } = {},
) {
  const master = generateKeyPair(opts.keyName ?? "vega-cache-1").secret;
  const pub = derivePublicKey(master);

  const hashId = "abc123def456abc123def456abc123de";
  const info: NarInfo = {
    storePath: `/nix/store/${hashId}-hello-2.12.1`,
    url: "nar/00deadbeef.nar.zst",
    compression: "zstd",
    fileHash: "sha256:1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    fileSize: 4242,
    narHash: "sha256:0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    narSize: 9001,
    references: [`${hashId}-hello-2.12.1`, "zzzlibc-2.39"],
    sigs: [],
  };
  const fp = fingerprint(info);
  info.sigs = [signNarInfo(info, master)];

  // Log: two decoys, then the real promotion leaf, then another decoy.
  const promotion = JSON.stringify({
    v: 1,
    event: "promotion",
    storePath: info.storePath,
    fingerprint: fp,
    narHash: info.narHash,
    agreedSince: 1000,
    at: 2000,
  });
  const leavesData = [
    JSON.stringify({ v: 1, event: "promotion", storePath: "/nix/store/other-a", fingerprint: "x", narHash: "y", at: 1 }),
    JSON.stringify({ v: 1, event: "revocation", storePath: "/nix/store/other-b", reason: "test", at: 2 }),
    promotion,
    JSON.stringify({ v: 1, event: "promotion", storePath: "/nix/store/other-c", fingerprint: "z", narHash: "w", at: 3 }),
  ];
  const promotionIndex = 2;

  const leafBytes = leavesData.map((d) => utf8.encode(d));
  const root = merkleRoot(leafBytes);
  const sth: Sth = { size: leavesData.length, rootHash: hex(root), timestamp: 5555 };
  sth.signature = signBytes(master, sthMessage(sth));

  const proof: InclusionProof = {
    index: promotionIndex,
    size: leavesData.length,
    leafHashHex: hex(leafHash(leafBytes[promotionIndex]!)),
    rootHex: hex(root),
    proofHex: inclusionProof(leafBytes, promotionIndex).map(hex),
  };

  const f: Fixture = { master, pub, info, hashId, leavesData, sth, proof, promotionIndex };
  opts.tamper?.(f);

  const narinfoText = formatNarInfo(f.info);
  const fetcher: Fetcher = async (path) => {
    // A healthy cache answers the revocation list, signed the way the control
    // plane signs it. `revocations` lets a case publish a real revocation.
    const revList = opts.revocations ? opts.revocations(f) : [];
    const map: Record<string, unknown> = {
      [`/${f.hashId}.narinfo`]: narinfoText,
      "/log/sth": f.sth,
      [`/log/proof/inclusion/${f.proof.index}`]: f.proof,
      "/api/revocations": (() => {
        const at = Date.now();
        return {
          v: 2,
          revocations: revList,
          total: revList.length,
          at,
          signature: signBytes(
            master,
            new TextEncoder().encode(
              `vega-revocations:v2:${at}:${revList.length}:${JSON.stringify(revList)}`,
            ),
          ),
        };
      })(),
    };
    f.leavesData.forEach((data, i) => {
      map[`/log/entry/${i}`] = { index: i, data };
    });
    const v = map[path];
    if (v === undefined) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      text: async () => (typeof v === "string" ? v : JSON.stringify(v)),
      json: async () => v,
    };
  };
  return { fetcher, pub, master, info: f, narinfoText };
}

interface Fixture {
  master: ReturnType<typeof generateKeyPair>["secret"];
  pub: ReturnType<typeof derivePublicKey>;
  info: NarInfo;
  hashId: string;
  leavesData: string[];
  sth: Sth;
  proof: InclusionProof;
  promotionIndex: number;
}

describe("verifyBuild", () => {
  it("fully verifies a genuine shared build (signature + STH + inclusion + binding)", async () => {
    const { fetcher, pub, info } = scenario();
    const r = await verifyBuild({ fetcher, info: info.info, publicKey: pub, sharedKeyName: "vega-cache-1" });
    expect(r.signature.ok).toBe(true);
    expect(r.signature.scope).toBe("shared");
    expect(r.transparency.sthVerified).toBe(true);
    expect(r.transparency.found).toBe(true);
    expect(r.transparency.index).toBe(2);
    expect(r.transparency.leafHashOk).toBe(true);
    expect(r.transparency.inclusionOk).toBe(true);
    expect(r.transparency.bindingOk).toBe(true);
    expect(fullyVerified(r)).toBe(true);
  });

  it("will not fully verify a binding Vega has revoked", async () => {
    // Signature and log proof both still hold: they say the binding was made and
    // recorded, not that it still stands. Reporting a clean pass here is the one
    // answer a verifier must never give.
    const { fetcher, pub, info } = scenario({
      revocations: (f) => [
        { hash: f.hashId, storePath: f.info.storePath, reason: "source withdrawn", at: 1_700_000_000_000 },
      ],
    });
    const r = await verifyBuild({ fetcher, info: info.info, publicKey: pub, sharedKeyName: "vega-cache-1" });
    expect(r.signature.ok).toBe(true);
    expect(r.transparency.found).toBe(true); // everything else is still good
    expect(r.revocation.revoked).toBe(true);
    expect(r.revocation.reason).toBe("source withdrawn");
    expect(fullyVerified(r)).toBe(false);
  });

  it("reports unknown, not clean, when the revocation list cannot be trusted", async () => {
    // A cache that withholds or forges the list must not be indistinguishable
    // from one with nothing to hide.
    const { fetcher, pub, info } = scenario();
    const noList: Fetcher = async (path) =>
      path === "/api/revocations"
        ? { ok: false, status: 503, text: async () => "", json: async () => ({}) }
        : fetcher(path);
    const r = await verifyBuild({ fetcher: noList, info: info.info, publicKey: pub, sharedKeyName: "vega-cache-1" });
    expect(r.revocation.revoked).toBeNull();
    expect(fullyVerified(r)).toBe(false);

    // A list whose signature does not verify is equally unusable.
    const forged: Fetcher = async (path) =>
      path === "/api/revocations"
        ? {
            ok: true,
            status: 200,
            text: async () => "",
            json: async () => ({
              v: 2,
              revocations: [],
              total: 0,
              at: Date.now(),
              signature: "vega-cache-1:AAAA",
            }),
          }
        : fetcher(path);
    const r2 = await verifyBuild({ fetcher: forged, info: info.info, publicKey: pub, sharedKeyName: "vega-cache-1" });
    expect(r2.revocation.revoked).toBeNull();
    expect(r2.revocation.note).toMatch(/signature/);
    expect(fullyVerified(r2)).toBe(false);
  });

  it("treats a stale or truncated list as unknown, not as clean", async () => {
    // A valid signature proves origin, not recency or completeness. A capture
    // taken before a revocation still verifies for ever, and a list the server
    // capped still verifies while missing the entries that fell off. Either can
    // be the wrong answer, which is worse than no answer.
    const { fetcher, pub, master, info } = scenario();
    const stale: Fetcher = async (path) =>
      path === "/api/revocations"
        ? {
            ok: true,
            status: 200,
            text: async () => "",
            json: async () => {
              const at = Date.now() - 48 * 60 * 60 * 1000; // two days old
              return {
                v: 2,
                revocations: [],
                total: 0,
                at,
                signature: signBytes(
                  master,
                  new TextEncoder().encode(`vega-revocations:v2:${at}:0:[]`),
                ),
              };
            },
          }
        : fetcher(path);
    const r = await verifyBuild({ fetcher: stale, info: info.info, publicKey: pub, sharedKeyName: "vega-cache-1" });
    expect(r.revocation.revoked).toBeNull();
    expect(r.revocation.note).toMatch(/stale/);

    const truncated: Fetcher = async (path) =>
      path === "/api/revocations"
        ? {
            ok: true,
            status: 200,
            text: async () => "",
            json: async () => {
              const at = Date.now();
              return {
                v: 2,
                revocations: [],
                total: 7, // the server holds seven; it served none of them
                at,
                signature: signBytes(
                  master,
                  new TextEncoder().encode(`vega-revocations:v2:${at}:7:[]`),
                ),
              };
            },
          }
        : fetcher(path);
    const r2 = await verifyBuild({ fetcher: truncated, info: info.info, publicKey: pub, sharedKeyName: "vega-cache-1" });
    expect(r2.revocation.revoked).toBeNull();
    expect(r2.revocation.note).toMatch(/truncated/);
  });

  it("rejects when verified against the wrong trusted key", async () => {
    const { fetcher, info } = scenario();
    const wrong = generateKeyPair("vega-cache-1").public; // same name, different key
    const r = await verifyBuild({ fetcher, info: info.info, publicKey: wrong, sharedKeyName: "vega-cache-1" });
    expect(r.signature.ok).toBe(false);
    expect(r.transparency.sthVerified).toBe(false);
    expect(fullyVerified(r)).toBe(false);
  });

  it("flags a tampered STH signature", async () => {
    const { fetcher, pub, info } = scenario({
      tamper: (f) => {
        f.sth.timestamp = 9999; // signature no longer matches the message
      },
    });
    const r = await verifyBuild({ fetcher, info: info.info, publicKey: pub, sharedKeyName: "vega-cache-1" });
    expect(r.signature.ok).toBe(true);
    expect(r.transparency.sthVerified).toBe(false);
    expect(fullyVerified(r)).toBe(false);
  });

  it("does not find a leaf whose bound narHash differs from the narinfo", async () => {
    const { fetcher, pub, info } = scenario({
      tamper: (f) => {
        // Repoint the promotion leaf at a different narHash; binding must fail.
        const leaf = JSON.parse(f.leavesData[f.promotionIndex]!);
        leaf.narHash = "sha256:tampered";
        f.leavesData[f.promotionIndex] = JSON.stringify(leaf);
      },
    });
    const r = await verifyBuild({ fetcher, info: info.info, publicKey: pub, sharedKeyName: "vega-cache-1" });
    // The leaf no longer binds, so it is not accepted and inclusion is not claimed.
    expect(r.transparency.found).toBe(false);
    expect(r.transparency.inclusionOk).toBe(false);
    expect(fullyVerified(r)).toBe(false);
  });

  it("rejects a forged inclusion proof against the signed root", async () => {
    const { fetcher, pub, info } = scenario({
      tamper: (f) => {
        f.proof.proofHex = f.proof.proofHex.map((h) => h.replace(/./, (c) => (c === "0" ? "1" : "0")));
      },
    });
    const r = await verifyBuild({ fetcher, info: info.info, publicKey: pub, sharedKeyName: "vega-cache-1" });
    expect(r.transparency.found).toBe(true);
    expect(r.transparency.inclusionOk).toBe(false);
    expect(fullyVerified(r)).toBe(false);
  });

  it("treats a scoped (non-shared) binding as signature-only", async () => {
    const { fetcher, pub, info } = scenario({ keyName: "vega-owner-42-1" });
    const r = await verifyBuild({ fetcher, info: info.info, publicKey: pub, sharedKeyName: "vega-cache-1" });
    expect(r.signature.ok).toBe(true);
    expect(r.signature.scope).toBe("scoped");
    expect(r.transparency.found).toBe(false);
    expect(r.transparency.note).toMatch(/scoped/);
    expect(fullyVerified(r)).toBe(false);
  });

  it("classifies a non-Vega key as an upstream mirror, not a Vega binding", async () => {
    const { fetcher, pub, info } = scenario({ keyName: "cache.nixos.org-1" });
    const r = await verifyBuild({ fetcher, info: info.info, publicKey: pub, sharedKeyName: "vega-cache-1" });
    expect(r.signature.ok).toBe(true);
    expect(r.signature.scope).toBe("upstream");
    expect(r.transparency.note).toMatch(/mirrored upstream/);
    expect(fullyVerified(r)).toBe(false);
  });

  it("bounds the scan and reports when the leaf is beyond maxScan", async () => {
    const { fetcher, pub, info } = scenario();
    const r = await verifyBuild({ fetcher, info: info.info, publicKey: pub, sharedKeyName: "vega-cache-1", maxScan: 1 });
    expect(r.transparency.found).toBe(false);
    expect(r.transparency.scanned).toBe(1);
    expect(r.transparency.note).toMatch(/most recent 1 of/);
  });

  it("finds a recently promoted leaf even when the log is larger than maxScan (newest-first)", async () => {
    // The promotion leaf is at index 2 of 4; scanning newest-first with a cap of
    // 2 reaches indexes 3 then 2, so it is found. An oldest-first scan with the
    // same cap would stop at indexes 0,1 and wrongly report the build absent.
    const { fetcher, pub, info } = scenario();
    const r = await verifyBuild({ fetcher, info: info.info, publicKey: pub, sharedKeyName: "vega-cache-1", maxScan: 2 });
    expect(r.transparency.found).toBe(true);
    expect(r.transparency.index).toBe(2);
    expect(r.transparency.scanned).toBe(2);
  });
});
