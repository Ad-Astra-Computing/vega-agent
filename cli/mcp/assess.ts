/**
 * `vega_assess_change` and the shared Vega verdict envelope.
 *
 * A "change" is the set of /nix/store paths it adds to a closure (resolved
 * elsewhere, e.g. by `vega gate --json` or the agent). This assesses the trust
 * standing of those added paths and rolls them up into one allow/warn/deny, so an
 * AI agent or CI can gate a dependency change before installing it.
 *
 * Security posture (consistent with the rest of the MCP surface, see tools.ts):
 *  - READ-ONLY. It resolves nothing, builds nothing, and realises nothing. It
 *    only verifies already-resolved paths against the pinned cache (LLM06).
 *  - Every per-path verdict is the SAME proof-backed verdict `vega_risk` gives
 *    (signature against a key you already trust + signed tree head + RFC 9162
 *    inclusion + NAR re-hash), never a heuristic or a server-asserted status.
 *  - Bounded: at most MAX_ASSESS_PATHS paths are verified per call, so one call's
 *    work is finite (LLM10). A larger change cannot be `allow` (it was not fully
 *    assessed); the truncation is reported, never silent.
 *  - "Cannot make a trust statement" (not in the cache, no trusted key) is a
 *    WARN, never a deny. Deny is reserved for a path a Vega proof actively
 *    refutes (bad signature, NAR mismatch, forged inclusion).
 */

import { runVerify, assessRisk, isError, type ToolContext } from "./tools.js";
import { untrusted } from "./sanitize.js";

/** The schema identifier all Vega verdicts carry, so a consumer can branch on a
 * stable version rather than the shape. Bump only on a breaking shape change. */
export const VERDICT_SCHEMA_VERSION = "vega.verdict.v1";

export type Verdict = "allow" | "warn" | "deny";

/** The uniform envelope every Vega gate returns: a verdict, the codes and next
 * actions behind it, and a tool-specific `evidence` payload (a tagged union). */
export interface VegaVerdict<E = unknown> {
  schemaVersion: typeof VERDICT_SCHEMA_VERSION;
  tool: string;
  target?: { type: "storePath" | "storeHash" | "closureDelta" | "installable"; value: string };
  verdict: Verdict;
  reasonCodes: string[];
  nextActions: string[];
  evidence: E;
}

export interface PathAssessment {
  /** The added store path, sanitized for inert display (LLM01/LLM05). */
  path: string;
  verdict: Verdict;
  tier: "shared" | "scoped" | "upstream" | "unknown";
  /** Proof-backed reason codes from the per-path verdict (or a single classifier
   * like NOT_IN_CACHE when no trust statement could be made). */
  reasonCodes: string[];
}

export interface ChangeAssessmentEvidence {
  kind: "changeAssessment";
  addedClosure: { count: number; assessed: number; truncated: boolean };
  summary: { verdicts: Record<Verdict, number>; tiers: Record<string, number> };
  paths: PathAssessment[];
}

/** Max store paths verified in one change. Each verified path does a full
 * client-side check (narinfo + signed tree head + inclusion proof + NAR
 * re-hash), so this bounds the work of one call. */
export const MAX_ASSESS_PATHS = 50;

/** Tighter bounds for the shared, SERIAL stdio MCP server, where one call must
 * not be able to monopolize the process. Each path can re-hash a NAR (up to the
 * fetcher's own timeout), so without a wall-clock budget 50 paths could occupy
 * the server for an hour-plus (a practical DoS). The MCP tool caps the path
 * count AND stops once the budget elapses, returning a non-allow time-budget
 * verdict; the worst case is then roughly the budget plus one in-flight NAR. */
export const MCP_ASSESS_MAX_PATHS = 25;
export const MCP_ASSESS_BUDGET_MS = 60_000;

export interface AssessOptions {
  /** Hard cap on how many unique paths are verified (default MAX_ASSESS_PATHS). */
  maxPaths?: number;
  /** Wall-clock budget for the whole call; verification stops once it elapses. */
  budgetMs?: number;
  /** Injectable clock for deterministic tests (defaults to Date.now). */
  now?: () => number;
}

const RANK: Record<Verdict, number> = { allow: 0, warn: 1, deny: 2 };
/** Worst-case combiner: deny dominates warn dominates allow. */
function worst(a: Verdict, b: Verdict): Verdict {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Verify one added path and map it to a per-path verdict. A path we cannot make
 * a trust statement about (not in the cache, no trusted key, not a store path) is
 * a WARN with the classifier code; a path a proof refutes is a DENY. */
async function assessOnePath(ctx: ToolContext, raw: string): Promise<PathAssessment> {
  const path = untrusted(raw, 512);
  const v = await runVerify(ctx, raw);
  if (isError(v)) {
    return { path, verdict: "warn", tier: "unknown", reasonCodes: [v.code ?? "NOT_ASSESSABLE"] };
  }
  const r = assessRisk(v.result, v.narOk, v.narChecked);
  return { path, verdict: r.verdict, tier: r.tier, reasonCodes: r.reasonCodes };
}

/**
 * Assess the trust standing of the store paths a change adds. Dedupes the input,
 * verifies up to `maxPaths` of them within an optional wall-clock `budgetMs`, and
 * rolls the per-path verdicts up into one change-level verdict (worst case wins).
 * Returns the shared envelope. Stopping early for ANY reason (path cap or time
 * budget) marks the change truncated, which forces a non-allow verdict: a change
 * that was not assessed in full cannot be certified.
 */
export async function assessChange(
  ctx: ToolContext,
  rawPaths: string[],
  opts: AssessOptions = {},
): Promise<VegaVerdict<ChangeAssessmentEvidence>> {
  const maxPaths = opts.maxPaths ?? MAX_ASSESS_PATHS;
  const now = opts.now ?? Date.now;
  const deadline = opts.budgetMs !== undefined ? now() + opts.budgetMs : Infinity;

  const unique = [...new Set(rawPaths.filter((p) => typeof p === "string"))];
  const capped = unique.slice(0, maxPaths);

  // Serial: the MCP stdio server is serial and each path may re-hash a NAR; this
  // keeps memory and concurrency bounded. The deadline is checked BEFORE each
  // path so the call cannot monopolize the server beyond the budget (plus, at
  // most, one in-flight NAR check).
  const paths: PathAssessment[] = [];
  let timedOut = false;
  for (const p of capped) {
    if (now() >= deadline) {
      timedOut = true;
      break;
    }
    paths.push(await assessOnePath(ctx, p));
  }

  const verdicts: Record<Verdict, number> = { allow: 0, warn: 0, deny: 0 };
  const tiers: Record<string, number> = {};
  let verdict: Verdict = "allow";
  for (const pa of paths) {
    verdicts[pa.verdict] += 1;
    tiers[pa.tier] = (tiers[pa.tier] ?? 0) + 1;
    verdict = worst(verdict, pa.verdict);
  }

  // Truncated if we did not assess every UNIQUE path, whether because of the path
  // cap or the time budget. Either way the change is not fully assessed.
  const truncated = paths.length < unique.length;

  const reasonCodes: string[] = [];
  const nextActions = new Set<string>();
  if (paths.length === 0 && !truncated) {
    reasonCodes.push("change.noPaths");
  } else if (verdicts.deny > 0) {
    reasonCodes.push("change.hasDeniedPaths");
  } else if (verdicts.warn > 0) {
    reasonCodes.push("change.hasUnverifiedPaths");
  } else if (paths.length > 0) {
    reasonCodes.push("change.allPathsVerified");
  }

  if (truncated) {
    reasonCodes.push(timedOut ? "change.timeBudgetExceeded" : "change.truncated");
    verdict = worst(verdict, "warn"); // an unassessed remainder cannot be certified
    nextActions.add(`assess in batches of <= ${maxPaths} paths, or run \`vega gate\` first to bound the delta`);
  }
  if (verdicts.warn > 0) nextActions.add("verify a specific path with vega_verify / vega_risk before depending on it");
  if (verdicts.deny > 0) nextActions.add("build the denied paths locally; a Vega proof refuted them");

  return {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    tool: "vega_assess_change",
    target: { type: "closureDelta", value: `${paths.length} of ${unique.length} added path(s)` },
    verdict,
    reasonCodes,
    nextActions: [...nextActions],
    evidence: {
      kind: "changeAssessment",
      addedClosure: { count: unique.length, assessed: paths.length, truncated },
      summary: { verdicts, tiers },
      paths,
    },
  };
}

/**
 * `vega_assess_change`: READ-ONLY. Given the store paths a change adds (resolved
 * by the caller, e.g. `vega gate --json`), return one allow/warn/deny verdict for
 * the whole change, with a per-path breakdown. It never resolves or builds.
 *
 * Runs under the tight MCP bounds (path cap + wall-clock budget) so one call
 * cannot monopolize the shared serial stdio server.
 */
export async function assessChangeTool(
  ctx: ToolContext,
  input: { paths: string[] },
): Promise<VegaVerdict<ChangeAssessmentEvidence>> {
  return assessChange(ctx, input.paths, { maxPaths: MCP_ASSESS_MAX_PATHS, budgetMs: MCP_ASSESS_BUDGET_MS });
}
