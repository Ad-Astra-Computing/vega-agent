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

export type Lane = "gh-actions" | "owner" | "pool";

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
}

export const PROMOTION = {
  /** Distinct tenants that must agree on one fingerprint for shared promotion. */
  sharedMinTenants: 2,
  /** Summed reputation weight (across distinct tenants) required for shared. */
  weightThreshold: 4,
} as const;

/**
 * Reputation weight for an account of a given age. Ramps from ~2 at one year to
 * a cap of 5 at four years. With `weightThreshold = 4`, two ~1-year tenants just
 * clear the bar; younger or fewer do not.
 */
export function accountWeight(accountAgeDays: number): number {
  const w = 1 + accountAgeDays / 365;
  return Math.max(1, Math.min(w, 5));
}

export type SharedReason = "agreement" | "insufficient" | "diverged";

export interface SharedDecision {
  promoted: boolean;
  fingerprint: string | null;
  reason: SharedReason;
  /** Distinct tenants behind the leading fingerprint. */
  distinctTenants: number;
  /** Summed reputation weight behind the leading fingerprint. */
  weight: number;
}

export interface PromotionDecision {
  /** Tenants currently promoted in their own namespace, and the fingerprint each vouches. */
  tenantTier: { tenant: string; fingerprint: string }[];
  shared: SharedDecision;
  /** True when more than one distinct fingerprint has been observed at all. */
  diverged: boolean;
}

interface Group {
  fingerprint: string;
  distinctTenants: number;
  weight: number;
}

export function decidePromotion(
  records: readonly AttestationRecord[],
  cfg: { sharedMinTenants: number; weightThreshold: number } = PROMOTION,
): PromotionDecision {
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
  const perFp = new Map<string, Map<string, number>>();
  for (const r of live) {
    if (r.tenant === null) continue;
    const tenants = perFp.get(r.fingerprint) ?? new Map<string, number>();
    tenants.set(r.tenant, Math.max(tenants.get(r.tenant) ?? 0, r.weight));
    perFp.set(r.fingerprint, tenants);
  }

  const groups: Group[] = [...perFp.entries()].map(([fingerprint, tenants]) => ({
    fingerprint,
    distinctTenants: tenants.size,
    weight: [...tenants.values()].reduce((a, b) => a + b, 0),
  }));

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
    shared = {
      promoted: true,
      fingerprint: candidates[0]!.fingerprint,
      reason: "agreement",
      distinctTenants: candidates[0]!.distinctTenants,
      weight: candidates[0]!.weight,
    };
  } else if (candidates.length > 1) {
    shared = { promoted: false, fingerprint: null, reason: "diverged", ...leadStats };
  } else {
    shared = { promoted: false, fingerprint: null, reason: "insufficient", ...leadStats };
  }

  return { tenantTier, shared, diverged };
}
