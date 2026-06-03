/**
 * Pure verification core for `vega verify`. Everything here is portable and
 * network-injectable (takes a `Fetcher`) so it can be unit-tested without a live
 * cache. The command layer (commands/verify.ts) adds Node-only steps: resolving
 * the trusted key and re-deriving the NAR hash by downloading the archive.
 *
 * What "verify" proves, using only primitives Vega already ships:
 *   1. the cache's signature on the narinfo is valid under a key you trust,
 *   2. the signed tree head (STH) is validly signed under that key,
 *   3. a promotion leaf binding this exact build is in the log, and
 *   4. that leaf is included in the signed tree (RFC 9162 inclusion proof).
 * The bytes are checked separately by the caller (verifyNarHash).
 */

import { fingerprint } from "../src/nix/fingerprint.js";
import { verifyNarInfo, verifyBytes } from "../src/nix/signing.js";
import { leafHash, verifyInclusion } from "../src/transparency/merkle.js";
import type { NarInfo, NixPublicKey } from "../src/nix/types.js";

/** A minimal response shape so tests can supply an in-memory fetcher. */
export interface FetchResult {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
export type Fetcher = (path: string) => Promise<FetchResult>;

/**
 * Wrap a fetcher so a TRANSIENT server error (HTTP 5xx) or a thrown network
 * error is retried with exponential backoff, while 2xx/3xx/4xx are returned
 * as-is (a 404 "not found" or 4xx is a real answer, never retried). This makes
 * verification resilient to a transient cache error (for example a momentary
 * Durable Object error on a heavily-written endpoint) instead of failing the
 * whole check on one 500. Idempotent GETs only, so retrying is safe. `sleep` is
 * injectable for tests.
 */
export function withRetry(
  inner: Fetcher,
  opts: { tries?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Fetcher {
  const tries = Math.max(1, opts.tries ?? 3);
  const baseMs = opts.baseMs ?? 150;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (path) => {
    let lastErr: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await inner(path);
        if (res.status >= 500 && res.status <= 599 && i < tries - 1) {
          await sleep(baseMs * 2 ** i);
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (i >= tries - 1) throw e;
        await sleep(baseMs * 2 ** i);
      }
    }
    throw lastErr;
  };
}

export interface Sth {
  size: number;
  rootHash: string;
  timestamp: number;
  signature?: string;
}

export interface InclusionProof {
  index: number;
  size: number;
  leafHashHex: string;
  rootHex: string;
  proofHex: string[];
}

/** The JSON leaf the worker appends when it promotes a build (write.ts). */
export interface PromotionLeaf {
  v: number;
  event: string;
  storePath: string;
  fingerprint?: string;
  narHash?: string;
  at: number;
}

const utf8 = new TextEncoder();

/** Hard cap on how many log entries to scan when no explicit bound is given, so
 * a hostile cache cannot drive an unbounded GET loop via a huge `sth.size`. */
export const MAX_SCAN_DEFAULT = 10000;

/** Extract the 32-char store-path hash from a path, basename, hash, or
 * `<hash>.narinfo`. Pure: returns null on anything that isn't a valid hash, so
 * both the CLI (which turns null into a teaching error) and the MCP server
 * (which returns a structured error) can share it. */
export function parseStorePathHash(arg: string): string | null {
  const noSuffix = arg.replace(/\.narinfo$/, "");
  const base = noSuffix.includes("/") ? noSuffix.slice(noSuffix.lastIndexOf("/") + 1) : noSuffix;
  const hash = base.split("-")[0] ?? "";
  return /^[0-9a-z]{32}$/.test(hash) ? hash : null;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error(`invalid hex: ${hex.slice(0, 16)}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** The exact message the worker signs into an STH (app.ts /log/sth). */
export function sthMessage(sth: Sth): Uint8Array {
  return utf8.encode(`vega-sth:v1:${sth.size}:${sth.rootHash}:${sth.timestamp}`);
}

/** Verify the STH is validly signed under `pk`. False if unsigned or invalid. */
export function verifySth(pk: NixPublicKey, sth: Sth): boolean {
  return sth.signature !== undefined && verifyBytes(pk, sthMessage(sth), sth.signature);
}

export function parseLeaf(data: string): PromotionLeaf | null {
  try {
    const o = JSON.parse(data) as PromotionLeaf;
    if (typeof o.storePath === "string" && typeof o.event === "string") return o;
    return null;
  } catch {
    return null;
  }
}

/**
 * A promotion leaf binds this build iff it is a promotion event for the same
 * store path, the same NAR hash, and the same fingerprint the narinfo would
 * produce. Checking the fingerprint (storePath + narHash + narSize + refs)
 * means a forged leaf cannot claim a build it does not match.
 */
export function leafBindsNarInfo(leaf: PromotionLeaf, info: NarInfo): boolean {
  return (
    leaf.event === "promotion" &&
    leaf.storePath === info.storePath &&
    leaf.narHash === info.narHash &&
    leaf.fingerprint === fingerprint(info)
  );
}

/**
 * Recompute the leaf hash from the raw entry bytes and verify it is included in
 * the tree whose root the STH signed. We deliberately verify against the SIGNED
 * `sth.rootHash`, never the proof's self-reported `rootHex`.
 */
export function verifyLeafInclusion(
  entryData: string,
  proof: InclusionProof,
  sth: Sth,
): { leafHashOk: boolean; inclusionOk: boolean } {
  const computed = leafHash(utf8.encode(entryData));
  const leafHashOk = bytesToHex(computed) === proof.leafHashHex;
  const inclusionOk =
    proof.size === sth.size &&
    verifyInclusion(computed, proof.index, sth.size, proof.proofHex.map(hexToBytes), hexToBytes(sth.rootHash));
  return { leafHashOk, inclusionOk };
}

export interface VerifyResult {
  storePath: string;
  narHash: string;
  signature: { ok: boolean; keyName: string; scope: "shared" | "scoped" | "upstream" };
  transparency: {
    found: boolean;
    index: number | null;
    sthVerified: boolean;
    leafHashOk: boolean;
    inclusionOk: boolean;
    bindingOk: boolean;
    scanned: number;
    note?: string;
  };
}

export interface VerifyOptions {
  fetcher: Fetcher;
  /** The single, already-fetched narinfo snapshot to verify (used for the
   * signature, the log binding, and by the caller for the NAR bytes too, so
   * every check is against the same document). */
  info: NarInfo;
  /** The key the user trusts (from nix.conf or a flag, never the cache). */
  publicKey: NixPublicKey;
  /** The shared/global key name; a match means a globally-trusted binding. */
  sharedKeyName: string;
  /** Upper bound on how many log entries to scan when locating the leaf. */
  maxScan?: number;
}

async function getJson(fetcher: Fetcher, path: string): Promise<unknown> {
  const res = await fetcher(path);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

/**
 * Run the signature + transparency-log checks. Throws only on a missing narinfo
 * (nothing to verify); every other failure is reported as a false flag in the
 * result so the caller can render a complete verdict.
 */
export async function verifyBuild(opts: VerifyOptions): Promise<VerifyResult> {
  const { fetcher, info, publicKey, sharedKeyName } = opts;

  // 1. Signature: accept iff some Sig validates under the trusted key. The key
  // name classifies the binding: the global shared key, a scoped Vega key
  // (vega-<owner>/<tenant>/<view>-1), or an upstream mirror key (e.g.
  // cache.nixos.org-1) for a path Vega only proxies.
  const sigOk = info.sigs.some((sig) => verifyNarInfo(info, sig, publicKey));
  const scope: "shared" | "scoped" | "upstream" =
    publicKey.name === sharedKeyName ? "shared" : publicKey.name.startsWith("vega-") ? "scoped" : "upstream";

  const result: VerifyResult = {
    storePath: info.storePath,
    narHash: info.narHash,
    signature: { ok: sigOk, keyName: publicKey.name, scope },
    transparency: {
      found: false,
      index: null,
      sthVerified: false,
      leafHashOk: false,
      inclusionOk: false,
      bindingOk: false,
      scanned: 0,
    },
  };

  // Only the shared tier is promoted into the global transparency log; scoped
  // Vega bindings and upstream mirrors are signature-only by design.
  if (scope !== "shared") {
    result.transparency.note =
      scope === "upstream"
        ? `mirrored upstream (signed by ${publicKey.name}); not a Vega trust statement`
        : "scoped binding: signature-only, not in the global transparency log";
    return result;
  }

  // 2. Signed tree head.
  const sth = (await getJson(fetcher, "/log/sth")) as Sth;
  result.transparency.sthVerified = verifySth(publicKey, sth);

  // 3. Locate the promotion leaf for this exact build by scanning the log. The
  // scan is bounded by an explicit cap or MAX_SCAN_DEFAULT, never by the cache's
  // self-reported size alone (a hostile cache could claim a huge size).
  const size = Number.isFinite(sth.size) && sth.size > 0 ? Math.floor(sth.size) : 0;
  const cap = opts.maxScan !== undefined && opts.maxScan > 0 ? Math.floor(opts.maxScan) : MAX_SCAN_DEFAULT;
  const limit = Math.min(cap, size);
  let index: number | null = null;
  let entryData: string | null = null;
  for (let i = 0; i < limit; i++) {
    result.transparency.scanned = i + 1;
    const entry = (await getJson(fetcher, `/log/entry/${i}`)) as { index: number; data: string };
    const leaf = parseLeaf(entry.data);
    if (leaf && leafBindsNarInfo(leaf, info)) {
      index = i;
      entryData = entry.data;
      break;
    }
  }
  if (index === null || entryData === null) {
    result.transparency.note =
      limit < sth.size
        ? `no matching promotion leaf in the first ${limit} of ${sth.size} entries`
        : `no promotion leaf for this build in the log (${sth.size} entries)`;
    return result;
  }
  result.transparency.found = true;
  result.transparency.index = index;
  result.transparency.bindingOk = true; // leafBindsNarInfo already held to get here

  // 4. Inclusion proof against the signed root.
  const proof = (await getJson(fetcher, `/log/proof/inclusion/${index}`)) as InclusionProof;
  const { leafHashOk, inclusionOk } = verifyLeafInclusion(entryData, proof, sth);
  result.transparency.leafHashOk = leafHashOk;
  result.transparency.inclusionOk = inclusionOk;
  return result;
}

/** Every check that must hold for a fully-verified shared build. */
export function fullyVerified(r: VerifyResult): boolean {
  return (
    r.signature.ok &&
    r.signature.scope === "shared" &&
    r.transparency.found &&
    r.transparency.sthVerified &&
    r.transparency.leafHashOk &&
    r.transparency.inclusionOk &&
    r.transparency.bindingOk
  );
}
