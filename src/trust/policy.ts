// Trust/promotion TYPE contract shared with the control plane.
//
// The promotion DECISION logic (the distinct-owner quorum, reputation weights,
// the Vega-reproduction gate) is security-critical and lives in exactly ONE
// place: the control-plane worker (garnix-ci/edge/src/trust/policy.ts), which is
// what actually runs. This module deliberately carries only the data shapes the
// agent needs to talk about builds and decisions (BuildProvenance on the way in,
// PromotionDecision on the way back). It does NOT re-implement decidePromotion:
// a second copy silently drifts from the authoritative one and, if ever wired up
// or synced the wrong way, would encode a weaker model. Keep the policy
// single-sourced in the edge.

/** Which builder produced an attestation. */
export type Lane = "gh-actions" | "owner" | "pool" | "vega-repro";

/**
 * Where a build came from, enough for an independent reproducer to rebuild the
 * same derivation: a flake reference, the attribute path, and the locked
 * revision. The reproducer builds `<flakeRef>/<rev>#<attr>` and checks the
 * derivation hash. For the gh-actions lane `flakeRef`/`rev` are derived from the
 * OIDC token (not the client), so they cannot be spoofed.
 */
export interface BuildProvenance {
  flakeRef: string;
  attr: string;
  rev: string;
  /**
   * Optional subflake directory for a monorepo whose flake lives in a
   * subdirectory (`?dir=<dir>`). The reproducer builds
   * `<flakeRef>/<rev>?dir=<dir>#<attr>`. Absent for a root flake.
   */
  dir?: string;
}

export interface AttestationRecord {
  /** Unique per attestation source (a GH run id, an agent key fingerprint). */
  attesterId: string;
  /** Trust namespace: `owner/repo` for gh-actions, an owner id, or null (pool). */
  tenant: string | null;
  lane: Lane;
  /** The exact narinfo signing fingerprint claimed (the agreement key). */
  fingerprint: string;
  /** True for a verified gh-actions run or a registered owner agent. */
  isTrustRoot: boolean;
  /** Reputation weight (Worker-computed, e.g. from account age). */
  weight: number;
  /** Audit reference (e.g. the OIDC run identity). */
  sig: string;
  /** Unix ms. */
  attestedAt: number;
  /** Build provenance, when the attester supplied a reproducible attribute. */
  provenance?: BuildProvenance;
  /** Continent the attestation came from (or "XX" unknown); continent-only. */
  continent?: string;
}

export type SharedReason =
  | "agreement"
  | "insufficient"
  | "diverged"
  | "settling"
  | "awaiting-repro"
  | "revoked";

export interface SharedDecision {
  promoted: boolean;
  fingerprint: string | null;
  reason: SharedReason;
  /** Distinct tenants behind the leading fingerprint. */
  distinctTenants: number;
  /** Summed reputation weight behind the leading fingerprint. */
  weight: number;
  /** Tenants on the promoted fingerprint (for retroactive corroboration credit). */
  agreeingTenants: string[];
  /**
   * When the leading candidate first met the distinct-owner quorum (ms), or null
   * if the quorum is not met.
   */
  agreedSince: number | null;
  /** Distinct Vega-controlled reproductions matching the leading fingerprint. */
  vegaReproductions: number;
}

export interface PromotionDecision {
  /** Tenants currently promoted in their own namespace, and the fingerprint each vouches. */
  tenantTier: { tenant: string; fingerprint: string }[];
  shared: SharedDecision;
  /** True when more than one distinct fingerprint has been observed at all. */
  diverged: boolean;
  /** Distinct continents the attestations came from (excludes unknown). */
  continents: string[];
}
