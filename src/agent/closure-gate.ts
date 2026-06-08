/**
 * The closure-delta gate policy: a pure verdict over a {@link ClosureDelta}. The
 * `vega gate` command does the nix path-info exec, baseline I/O, and optional
 * cache lookups; this module decides allow/warn/deny so the policy is testable in
 * isolation. The core signal is "what new store paths did this change introduce
 * into the dependency closure" (a PR supply-chain delta); NAR-size growth is a
 * secondary bloat signal.
 */
import type { ClosureDelta } from "../nix/closure.js";

export type GateVerdict = "allow" | "warn" | "deny";

export interface GatePolicy {
  /** Warn/deny when the net NAR-size delta exceeds this percent of the baseline. */
  warnSizeDeltaPercent: number;
  denySizeDeltaPercent: number;
  /** Warn/deny when this many NEW store paths enter the closure. */
  warnNewPaths: number;
  denyNewPaths: number;
  /** How to treat new paths that are not backed by a trusted cache. `off` skips
   * the (network) cache lookup entirely. */
  cachePolicy: "off" | "warn" | "deny";
}

export const DEFAULT_GATE_POLICY: GatePolicy = {
  warnSizeDeltaPercent: 5,
  denySizeDeltaPercent: 20,
  warnNewPaths: 5,
  denyNewPaths: 25,
  cachePolicy: "off",
};

export interface GateResult {
  verdict: GateVerdict;
  /** Machine-readable `closure.*` codes, in escalation order. */
  reasonCodes: string[];
  /** Added NAR bytes as a percent of the baseline total (finite; 0 if baseline empty). */
  sizeDeltaPercent: number;
  newPathCount: number;
  removedPathCount: number;
  uncachedNewPathCount: number;
}

const RANK: Record<GateVerdict, number> = { allow: 0, warn: 1, deny: 2 };

/**
 * Assess a closure delta against the policy. `baselineTotalNarSize` is the sum of
 * the baseline closure's NAR sizes (for the percent calculation), and
 * `uncachedNewPaths` is how many of the added paths are NOT cache-backed (0 when
 * `cachePolicy` is off, i.e. no lookup was done).
 */
export function assessClosureGate(
  delta: ClosureDelta,
  baselineTotalNarSize: number,
  policy: GatePolicy,
  uncachedNewPaths = 0,
): GateResult {
  const codes: string[] = [];
  let verdict: GateVerdict = "allow";
  const escalate = (v: GateVerdict): void => {
    if (RANK[v] > RANK[verdict]) verdict = v;
  };

  const newPathCount = delta.added.length;
  // ADDED bytes as a fraction of the baseline: the bloat this change pulled in,
  // NOT the net (so removing a big old path cannot mask a big new one). 0 for an
  // empty baseline so the percent stays finite (an empty baseline is covered by
  // the new-path-count triggers, and an Infinity would serialize to JSON null).
  const sizeDeltaPercent = baselineTotalNarSize > 0 ? (delta.addedNarSize / baselineTotalNarSize) * 100 : 0;

  // Any new closure entry is at least a warn: this change pulled in dependencies
  // that were not there before. Removals alone do not escalate (allow).
  if (newPathCount > 0) {
    codes.push("closure.new_paths");
    escalate("warn");
  }
  if (delta.removed.length > 0) codes.push("closure.removed_paths"); // informational

  if (sizeDeltaPercent > policy.warnSizeDeltaPercent) {
    codes.push("closure.narsize_delta_warn");
    escalate("warn");
  }
  if (sizeDeltaPercent > policy.denySizeDeltaPercent) {
    codes.push("closure.narsize_delta_deny");
    escalate("deny");
  }
  if (newPathCount > policy.warnNewPaths) {
    codes.push("closure.new_path_count_warn");
    escalate("warn");
  }
  if (newPathCount > policy.denyNewPaths) {
    codes.push("closure.new_path_count_deny");
    escalate("deny");
  }
  if (policy.cachePolicy !== "off" && uncachedNewPaths > 0) {
    codes.push("closure.new_uncached_paths");
    escalate(policy.cachePolicy === "deny" ? "deny" : "warn");
  }

  return {
    verdict,
    reasonCodes: codes,
    sizeDeltaPercent,
    newPathCount,
    removedPathCount: delta.removed.length,
    uncachedNewPathCount: uncachedNewPaths,
  };
}
