/**
 * Two-tier promotion policy. Pure functions; the Durable Object
 * ({@link AttestationTally}) persists records and calls these.
 *
 * Shared promotion is the security-critical decision: it signs a global
 * `storePath -> content` binding with the master key. So it requires not just
 * distinct tenants agreeing on one output, but enough *reputation weight*
 * across them. A swarm of fresh/throwaway repos cannot reach the bar; a few
 * aged, independent tenants can. Weight is computed by the Worker (currently
 * from GitHub account age) and carried on each record. Anonymous pool attesters
 * (null tenant) never count toward shared agreement.
 */

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

export const PROMOTION = {
  /** Distinct tenants that must agree on one fingerprint for shared promotion. */
  sharedMinTenants: 2,
  /** Summed reputation weight (across distinct tenants) required for shared. */
  weightThreshold: 4,
} as const;

/** Configuration for {@link decidePromotion}. */
export interface PromotionConfig {
  sharedMinTenants: number;
  weightThreshold: number;
  /**
   * Settling window (ms): the leading candidate must have held the quorum for at
   * least this long before it can promote (#4). Default 0 (no delay), so the
   * gate is off until a deployment configures it.
   */
  promotionWindowMs?: number;
  /** Current time (ms), for the settling-window check. Default Date.now(). */
  now?: number;
  /**
   * Vega-controlled reproductions of the leading fingerprint required before
   * promotion (#1). Default 0 (not required), off until configured.
   */
  minVegaReproductions?: number;
}

/**
 * Reputation weight for an account of a given age. Ramps from ~2 at one year to
 * a cap of 5 at four years. With `weightThreshold = 4`, two ~1-year tenants just
 * clear the bar; younger or fewer do not.
 */
export function accountWeight(accountAgeDays: number): number {
  const w = 1 + accountAgeDays / 365;
  return Math.max(1, Math.min(w, 5));
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
   * if the quorum is not met. Computed per (path, fingerprint) candidate by
   * replaying the external attestations in time order: a later candidate cannot
   * inherit an earlier one's settle time.
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

interface Group {
  fingerprint: string;
  distinctTenants: number;
  weight: number;
  tenants: string[];
}

/**
 * The independent owner behind a tenant. gh-actions tenants are `owner/repo`, so
 * many repos under one org collapse to one owner; owner-lane tenants
 * (`owner:<login>`) are already per-person. Shared promotion counts distinct
 * owners, not repos, so an attacker cannot manufacture a quorum from several
 * repos they control under a single account.
 */
function ownerOf(tenant: string): string {
  const slash = tenant.indexOf("/");
  return slash > 0 ? tenant.slice(0, slash) : tenant;
}

/**
 * The moment the distinct-owner quorum was first met for a specific fingerprint:
 * replay that fingerprint's external attestations in attestation-time order and
 * return the timestamp of the one that first pushed both the owner count and the
 * summed weight over the bar. Per-candidate, so a fingerprint that reaches quorum
 * later starts its own settling clock and cannot inherit an earlier one's.
 */
function firstQuorumTime(
  records: readonly AttestationRecord[],
  fingerprint: string,
  cfg: PromotionConfig,
): number | null {
  const forFp = records
    .filter(
      (r) =>
        r.tenant !== null &&
        r.lane !== "vega-repro" &&
        r.lane !== "owner" &&
        r.fingerprint === fingerprint,
    )
    .sort((a, b) => a.attestedAt - b.attestedAt);
  const byOwner = new Map<string, number>();
  for (const r of forFp) {
    const o = ownerOf(r.tenant!);
    byOwner.set(o, Math.max(byOwner.get(o) ?? 0, r.weight));
    const weight = [...byOwner.values()].reduce((a, b) => a + b, 0);
    if (byOwner.size >= cfg.sharedMinTenants && weight >= cfg.weightThreshold) {
      return r.attestedAt;
    }
  }
  return null;
}

export function decidePromotion(
  records: readonly AttestationRecord[],
  cfg: PromotionConfig = PROMOTION,
): PromotionDecision {
  const windowMs = cfg.promotionWindowMs ?? 0;
  const now = cfg.now ?? Date.now();
  const minRepro = cfg.minVegaReproductions ?? 0;
  // One record per attester (last wins).
  const byAttester = new Map<string, AttestationRecord>();
  for (const r of records) byAttester.set(r.attesterId, r);
  const live = [...byAttester.values()];

  // Tenant tier: each tenant's latest trust-root fingerprint.
  const tenantLatest = new Map<string, { fingerprint: string; attestedAt: number }>();
  for (const r of live) {
    if (!r.isTrustRoot || r.tenant === null) continue;
    const prev = tenantLatest.get(r.tenant);
    if (prev === undefined || r.attestedAt >= prev.attestedAt) {
      tenantLatest.set(r.tenant, { fingerprint: r.fingerprint, attestedAt: r.attestedAt });
    }
  }
  const tenantTier = [...tenantLatest.entries()].map(([tenant, v]) => ({
    tenant,
    fingerprint: v.fingerprint,
  }));

  // Shared tier: per fingerprint, the max weight per distinct (non-null) tenant.
  // Vega's own reproductions are NOT part of the external quorum (they are one
  // owner, Vega); they are a separate, mandatory gate counted below. Owner-lane
  // local pushes never reach this path (they are rejected at /attest), but we
  // exclude the lane here too as defense-in-depth: owner credentials authenticate
  // storage writes, never build truth, and must never count toward a quorum.
  const perFp = new Map<string, Map<string, number>>();
  for (const r of live) {
    if (r.tenant === null || r.lane === "vega-repro" || r.lane === "owner") continue;
    const tenants = perFp.get(r.fingerprint) ?? new Map<string, number>();
    tenants.set(r.tenant, Math.max(tenants.get(r.tenant) ?? 0, r.weight));
    perFp.set(r.fingerprint, tenants);
  }

  // Dedup the quorum by owner: collapse a tenant's repos to one owner and take
  // that owner's max weight, so many repos under one account count once.
  const groups: Group[] = [...perFp.entries()].map(([fingerprint, tenantWeights]) => {
    const byOwner = new Map<string, number>();
    for (const [tenant, w] of tenantWeights) {
      const o = ownerOf(tenant);
      byOwner.set(o, Math.max(byOwner.get(o) ?? 0, w));
    }
    return {
      fingerprint,
      distinctTenants: byOwner.size,
      weight: [...byOwner.values()].reduce((a, b) => a + b, 0),
      tenants: [...tenantWeights.keys()],
    };
  });

  const diverged = new Set(live.map((r) => r.fingerprint)).size > 1;
  const candidates = groups.filter(
    (g) => g.distinctTenants >= cfg.sharedMinTenants && g.weight >= cfg.weightThreshold,
  );
  const leading = groups.reduce<Group | null>(
    (best, g) => (best === null || g.weight > best.weight ? g : best),
    null,
  );
  const leadStats = {
    distinctTenants: leading?.distinctTenants ?? 0,
    weight: leading?.weight ?? 0,
  };

  let shared: SharedDecision;
  if (candidates.length === 1) {
    const winner = candidates[0]!;
    const fp = winner.fingerprint;
    const agreedSince = firstQuorumTime(live, fp, cfg);
    // Distinct Vega reproductions of the winning fingerprint.
    const vegaReproductions = live.filter(
      (r) => r.lane === "vega-repro" && r.fingerprint === fp,
    ).length;
    // A Vega reproduction that yielded a DIFFERENT fingerprint contests the
    // candidate: the master key must not sign over a Vega-detected divergence.
    const vegaConflict = live.some((r) => r.lane === "vega-repro" && r.fingerprint !== fp);

    const base = {
      fingerprint: fp,
      distinctTenants: winner.distinctTenants,
      weight: winner.weight,
      agreeingTenants: winner.tenants,
      agreedSince,
      vegaReproductions,
    };
    if (vegaConflict) {
      shared = { ...base, promoted: false, reason: "diverged" };
    } else if (agreedSince === null || now - agreedSince < windowMs) {
      shared = { ...base, promoted: false, reason: "settling" };
    } else if (vegaReproductions < minRepro) {
      shared = { ...base, promoted: false, reason: "awaiting-repro" };
    } else {
      shared = { ...base, promoted: true, reason: "agreement" };
    }
  } else if (candidates.length > 1) {
    shared = {
      promoted: false, fingerprint: null, reason: "diverged",
      ...leadStats, agreeingTenants: [], agreedSince: null, vegaReproductions: 0,
    };
  } else {
    shared = {
      promoted: false, fingerprint: null, reason: "insufficient",
      ...leadStats, agreeingTenants: [], agreedSince: null, vegaReproductions: 0,
    };
  }

  const continents = [
    ...new Set(
      live
        .map((r) => r.continent)
        .filter((co): co is string => typeof co === "string" && co !== "XX"),
    ),
  ].sort();

  return { tenantTier, shared, diverged, continents };
}
