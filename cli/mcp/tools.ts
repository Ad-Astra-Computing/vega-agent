/**
 * Vega MCP tool handlers: pure, transport-agnostic, and built entirely on the
 * already-reviewed `verify-core`. They take an injected fetcher + key resolver,
 * so they are unit-testable and never touch local secrets.
 *
 * Security posture (see sanitize.ts and the codex review):
 *  - READ-ONLY. No tool here mutates trust or spends build resources (LLM06,
 *    excessive agency). Write/build tools are deliberately not in v1.
 *  - The verification key comes from the caller's resolver (nix.conf / flag),
 *    NEVER from the cache, and inclusion is checked against the SIGNED root, so a
 *    hostile cache cannot make a build "verified" (this is verify-core's contract).
 *  - All cache-reported strings are passed through `untrusted()` before they
 *    enter a tool result (LLM01/LLM05).
 *  - The verdict is derived from cryptographic facts, never heuristics, so the
 *    agent cannot be fed a fabricated "trusted" (LLM09, misinformation).
 */

import {
  verifyBuild,
  fullyVerified,
  parseStorePathHash,
  type Fetcher,
  type VerifyResult,
} from "../verify-core.js";
import { parseNarInfo } from "../../src/nix/narinfo.js";
import type { NarInfo, NixPublicKey } from "../../src/nix/types.js";
import { untrusted } from "./sanitize.js";

export interface ToolContext {
  /** GETs against the PINNED cache origin only (no caller-supplied host). */
  fetcher: Fetcher;
  cacheUrl: string;
  /** The global shared key name (e.g. `vega-cache-1`). */
  sharedKeyName: string;
  /** Resolve a trusted public key for the narinfo's signature key names, from
   * the user's nix.conf / an explicit key. Returns null if none is trusted. */
  resolveKey(sigNames: string[]): Promise<NixPublicKey | null>;
  /** Re-derive the NAR bytes for a narinfo and confirm they hash to the signed
   * narHash. A valid signature and log record only bind the narinfo; this is the
   * independent content check, so without it a signed/logged narinfo over corrupt
   * or substituted bytes would falsely verify. Bounded by a fetch timeout. */
  verifyNar(info: Pick<NarInfo, "url" | "compression" | "narHash">): Promise<{ ok: boolean; detail: string }>;
  /** Bound the transparency-log scan (LLM10, unbounded consumption). */
  maxScan?: number;
}

export interface ToolError {
  error: string;
}
export function isError(v: unknown): v is ToolError {
  return typeof v === "object" && v !== null && typeof (v as ToolError).error === "string";
}

async function runVerify(
  ctx: ToolContext,
  target: string,
): Promise<{ result: VerifyResult; narOk: boolean; narDetail: string } | ToolError> {
  const hash = parseStorePathHash(target);
  if (hash === null) return { error: `'${untrusted(target, 80)}' is not a store path or hash` };

  const res = await ctx.fetcher(`/${hash}.narinfo`);
  if (!res.ok) return { error: `no build found for ${hash} (HTTP ${res.status})` };
  const info = parseNarInfo(await res.text());
  const sigNames = info.sigs.map((s) => s.slice(0, s.indexOf(":")).trim()).filter(Boolean);

  const publicKey = await ctx.resolveKey(sigNames);
  if (publicKey === null) {
    return {
      error: `no trusted public key is configured for this build (signed by: ${sigNames
        .map((s) => untrusted(s, 64))
        .join(", ")})`,
    };
  }

  const result = await verifyBuild({
    fetcher: ctx.fetcher,
    info,
    publicKey,
    sharedKeyName: ctx.sharedKeyName,
    maxScan: ctx.maxScan,
  });
  // Independent content check: re-derive the NAR bytes and confirm they hash to
  // the signed narHash. A build is only fully verified when this also passes.
  const nar = await ctx.verifyNar(info);
  return { result, narOk: nar.ok, narDetail: nar.detail };
}

/** Shape a VerifyResult into a fully-sanitized tool payload: EVERY string that
 * enters the agent's context is passed through `untrusted()`, including the key
 * name (which comes from nix.conf / a flag and is not validated for control
 * chars) and our own note. Booleans/indices are inherently safe. */
function shape(r: VerifyResult, narOk: boolean) {
  const t = r.transparency;
  return {
    storePath: untrusted(r.storePath, 512),
    narHash: untrusted(r.narHash, 128),
    signature: {
      ok: r.signature.ok,
      keyName: untrusted(r.signature.keyName, 128),
      scope: r.signature.scope,
    },
    transparency: {
      found: t.found,
      index: t.index,
      sthVerified: t.sthVerified,
      leafHashOk: t.leafHashOk,
      inclusionOk: t.inclusionOk,
      bindingOk: t.bindingOk,
      scanned: t.scanned,
      ...(t.note !== undefined ? { note: untrusted(t.note, 256) } : {}),
    },
    narHashVerified: narOk,
    verified: fullyVerified(r) && narOk,
  };
}

/** `vega_verify`: independent verification (signature + STH + inclusion). */
export async function verifyTool(
  ctx: ToolContext,
  input: { target: string },
): Promise<ReturnType<typeof shape> | ToolError> {
  const v = await runVerify(ctx, input.target);
  return isError(v) ? v : shape(v.result, v.narOk);
}

export interface RiskVerdict {
  verdict: "allow" | "warn" | "deny";
  tier: "shared" | "scoped" | "upstream";
  reasonCodes: string[];
  proofs: ReturnType<typeof shape>;
  nextActions: string[];
}

/** Map a verification result to a machine-actionable gate. Every code is backed
 * by a cryptographic fact in `proofs`; nothing here is a heuristic score. */
export function assessRisk(r: VerifyResult, narOk: boolean): RiskVerdict {
  const proofs = shape(r, narOk);
  const t = r.transparency;
  if (!r.signature.ok) {
    return {
      verdict: "deny",
      tier: r.signature.scope,
      reasonCodes: ["SIGNATURE_INVALID"],
      proofs,
      nextActions: ["build_locally", "pin_previous_verified_version"],
    };
  }
  // The served bytes must hash to the signed narHash; a content mismatch denies
  // regardless of tier (a valid signature over substituted bytes is still bad).
  if (!narOk) {
    return {
      verdict: "deny",
      tier: r.signature.scope,
      reasonCodes: ["NAR_HASH_MISMATCH"],
      proofs,
      nextActions: ["build_locally", "pin_previous_verified_version"],
    };
  }
  if (r.signature.scope === "upstream") {
    return {
      verdict: "allow",
      tier: "upstream",
      reasonCodes: ["MIRRORED_UPSTREAM", "NOT_A_VEGA_TRUST_STATEMENT"],
      proofs,
      nextActions: [],
    };
  }
  if (r.signature.scope === "scoped") {
    return {
      verdict: "warn",
      tier: "scoped",
      reasonCodes: ["SCOPED_BINDING_NOT_GLOBAL"],
      proofs,
      nextActions: ["request_shared_promotion", "build_locally"],
    };
  }
  // shared tier: must clear STH + inclusion to be allowed.
  if (!t.sthVerified) {
    return { verdict: "deny", tier: "shared", reasonCodes: ["STH_SIGNATURE_INVALID"], proofs, nextActions: ["build_locally"] };
  }
  if (!t.found) {
    return { verdict: "deny", tier: "shared", reasonCodes: ["NO_TRANSPARENCY_RECORD"], proofs, nextActions: ["request_reproduction", "build_locally"] };
  }
  if (!(t.leafHashOk && t.inclusionOk)) {
    return { verdict: "deny", tier: "shared", reasonCodes: ["INCLUSION_PROOF_FAILED"], proofs, nextActions: ["request_reproduction", "build_locally"] };
  }
  return {
    verdict: "allow",
    tier: "shared",
    reasonCodes: ["SHARED_REPRODUCED", "TRANSPARENCY_LOG_INCLUDED"],
    proofs,
    nextActions: [],
  };
}

/** `vega_risk`: an allow/warn/deny gate an agent or CI can act on. */
export async function riskTool(
  ctx: ToolContext,
  input: { target: string },
): Promise<RiskVerdict | ToolError> {
  const v = await runVerify(ctx, input.target);
  return isError(v) ? v : assessRisk(v.result, v.narOk);
}

const REPRO_STATUSES = ["reproducible", "diverged", "uncorroborated", "mirrored", "unknown"] as const;
type ReproStatus = (typeof REPRO_STATUSES)[number];
const REPRO_VERDICT: Record<ReproStatus, "allow" | "warn" | "deny"> = {
  reproducible: "allow",
  diverged: "deny",
  uncorroborated: "warn",
  mirrored: "warn",
  unknown: "warn",
};

export interface ReproduceVerdict {
  /** The validated store-path hash queried. */
  target: string;
  verdict: "allow" | "warn" | "deny";
  reproduction: { status: ReproStatus; agreeCount: number; diverged: boolean; inSharedCache: boolean };
  reasonCodes: string[];
  nextActions: string[];
}

/**
 * Parse a `/api/status` response into ONLY the fields vega_reproduce uses. An
 * unknown verdict collapses to "unknown" and counts default to 0, so a malformed
 * or hostile response can never crash the tool or smuggle an unsanitized string
 * into the result (the output is built from validated enums and numbers only).
 */
export function parseReproStatus(json: unknown): {
  status: ReproStatus;
  agreeCount: number;
  inSharedCache: boolean;
} {
  const o = (json ?? {}) as { verdict?: unknown; agree?: unknown; inSharedCache?: unknown };
  const status: ReproStatus =
    typeof o.verdict === "string" && (REPRO_STATUSES as readonly string[]).includes(o.verdict)
      ? (o.verdict as ReproStatus)
      : "unknown";
  const agreeCount =
    typeof o.agree === "number" && Number.isFinite(o.agree) && o.agree >= 0 ? Math.floor(o.agree) : 0;
  return { status, agreeCount, inSharedCache: o.inSharedCache === true };
}

/** Pure verdict from a parsed status; no caller/server strings echoed. */
export function assessReproduction(
  hash: string,
  s: { status: ReproStatus; agreeCount: number; inSharedCache: boolean },
): ReproduceVerdict {
  const verdict = REPRO_VERDICT[s.status];
  const diverged = s.status === "diverged";
  const nextActions: string[] =
    verdict === "allow" ? [] : ["reproduce it yourself locally: vega diff <the flake output or store path>"];
  if (diverged) nextActions.unshift("this build is non-reproducible: a Vega reproduction disagreed with it");
  return {
    target: hash,
    verdict,
    reproduction: { status: s.status, agreeCount: s.agreeCount, diverged, inSharedCache: s.inSharedCache },
    reasonCodes: [`reproduce.${s.status}`],
    nextActions,
  };
}

/**
 * `vega_reproduce`: READ-ONLY. Reports whether Vega has independently reproduced a
 * build, by querying the pinned cache's `/api/status`. It NEVER rebuilds (a build
 * spends compute and evaluates untrusted Nix; that stays out of the MCP surface,
 * LLM06). When the build is not reproduced it suggests running `vega diff`
 * locally rather than doing it.
 */
export async function reproduceTool(
  ctx: ToolContext,
  input: { target: string },
): Promise<ReproduceVerdict | ToolError> {
  const hash = parseStorePathHash(input.target);
  if (hash === null) return { error: `'${untrusted(input.target, 80)}' is not a store path or hash` };
  let res: Awaited<ReturnType<ToolContext["fetcher"]>>;
  try {
    res = await ctx.fetcher(`/api/status/${hash}`);
  } catch {
    return { error: `status lookup failed for ${hash}` };
  }
  if (!res.ok) return { error: `no status for ${hash} (HTTP ${res.status})` };
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { error: `malformed status response for ${hash}` };
  }
  return assessReproduction(hash, parseReproStatus(json));
}
