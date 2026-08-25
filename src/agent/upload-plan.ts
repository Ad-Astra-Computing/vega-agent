import { partitionByUpstream } from "./upstream.js";

/** A closure entry, as much of it as planning needs. */
export interface PlanEntry {
  path: string;
  narSize: number;
}

/** A path dropped by operator policy, and why, so the run can say so. */
export interface SkippedPath {
  path: string;
  narSize: number;
  reason: "excluded" | "too-large";
}

export interface UploadPlan {
  /** Store paths to compress, upload, and attest. */
  toUpload: string[];
  /** Paths the upstream cache already serves (no value re-uploading stock nixpkgs). */
  skippedUpstream: string[];
  /** Paths the operator's own policy dropped. Reported, never silent. */
  skippedByPolicy: SkippedPath[];
}

/**
 * `*` and `?` against a store path's NAME, anchored, matched in linear time.
 *
 * The name, not the whole path: the hash changes on every rebuild, so a pattern
 * written against the full path would match once and never again.
 *
 * Deliberately NOT compiled to a regex. Mapping each `*` to `.*` gives a pattern
 * whose alternatives multiply, and a wildcard-heavy glob then backtracks
 * catastrophically: `*a*a*a*a*a*a*a*a*a*b` against a 211-character name (the
 * store's name limit, so this is reachable) takes minutes for a SINGLE path,
 * runs once per closure entry, and happens during planning before the stall
 * watchdog starts, so the job wedges with no diagnostic at all. This is the
 * standard two-pointer walk instead: it backtracks only to the last `*`, which
 * is O(name x pattern) worst case and linear in practice.
 */
export function globMatches(glob: string, name: string): boolean {
  let g = 0;
  let n = 0;
  let starG = -1;
  let starN = 0;
  while (n < name.length) {
    if (g < glob.length && glob[g] === "*") {
      // The wildcard branch must come FIRST. Testing literal equality first
      // consumes a glob '*' as a literal when the name also has one at that
      // position, so '*' would not match '*a'. Nix rejects '*' in a store path
      // name, so no real closure entry reaches it, but this is exported and the
      // next caller may not be passing store names.
      starG = g++;
      starN = n;
    } else if (g < glob.length && (glob[g] === "?" || glob[g] === name[n])) {
      g++;
      n++;
    } else if (starG !== -1) {
      // Mismatch after a star: give the star one more character and retry.
      g = starG + 1;
      n = ++starN;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === "*") g++;
  return g === glob.length;
}

/** The part of a store path after `<hash>-`, e.g. `microvm-store-disk.erofs`. */
export function storePathName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dash = base.indexOf("-");
  return dash === -1 ? base : base.slice(dash + 1);
}

/**
 * Decide which of a build closure's paths need processing at all.
 *
 * Three plan-time skips, in this order because each is cheaper than the next:
 *
 * `exclude` and `maxNarBytes` are OPERATOR POLICY, for outputs nobody else can
 * use: a host-specific microVM disk image is gigabytes, changes whenever its
 * guest config does, and no other consumer will ever substitute it, so pushing
 * it spends the run's whole upload budget for nobody. They are applied first
 * because dropping a path costs nothing, while probing upstream for one costs a
 * request.
 *
 * `upstreamUrl` then drops paths cache.nixos.org already serves, since a system
 * closure is mostly stock nixpkgs. That probe fails a path INTO "upload" on any
 * error (see {@link partitionByUpstream}), so a transient failure never silently
 * drops a path from the cache.
 *
 * What an operator is choosing when they exclude: the path is neither uploaded
 * NOR attested, so it contributes nothing to any tier, and a consumer who
 * substitutes something that references it gets a dangling reference and has to
 * build or fetch it themselves. That is right for a host-specific artifact and
 * wrong for anything another machine might want, which is why the caller reports
 * what was dropped rather than leaving it to be discovered as a cache miss.
 *
 * Resumability (skipping a NAR a prior run of this build already uploaded) is
 * NOT decided here, because it must not drop a path from attestation and must
 * key on the exact compressed bytes, not the store path. It is handled per-path
 * at upload time via {@link narObjectExists}: the locally built output is always
 * attested, and only the redundant content-addressed PUT is skipped.
 */
export async function planUploads(
  closure: readonly PlanEntry[],
  opts: { upstreamUrl?: string; exclude?: readonly string[]; maxNarBytes?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<UploadPlan> {
  const patterns = (opts.exclude ?? []).filter((p) => p.trim() !== "");
  const cap = opts.maxNarBytes !== undefined && opts.maxNarBytes > 0 ? opts.maxNarBytes : undefined;

  const skippedByPolicy: SkippedPath[] = [];
  let remaining: PlanEntry[] = [];
  for (const e of closure) {
    if (patterns.some((p) => globMatches(p, storePathName(e.path)))) {
      skippedByPolicy.push({ path: e.path, narSize: e.narSize, reason: "excluded" });
    } else if (cap !== undefined && e.narSize > cap) {
      skippedByPolicy.push({ path: e.path, narSize: e.narSize, reason: "too-large" });
    } else {
      remaining.push(e);
    }
  }

  let paths = remaining.map((e) => e.path);
  let skippedUpstream: string[] = [];
  if (opts.upstreamUrl !== undefined) {
    const { novel, upstream } = await partitionByUpstream(paths, opts.upstreamUrl, fetchImpl);
    paths = novel;
    skippedUpstream = upstream;
  }
  return { toUpload: paths, skippedUpstream, skippedByPolicy };
}

/**
 * A NAR size ceiling from an operator-supplied string. Empty or absent means no
 * ceiling.
 *
 * Anything non-empty that is not a positive number THROWS rather than falling
 * back to "no ceiling". This knob exists to prevent an accidental multi-gigabyte
 * push, and `max-nar-bytes: 1_000_000_000` (or `2GB`, both natural ways to write
 * it) parses as NaN. Silently treating that as "no limit" would disable the
 * guard at exactly the moment the operator believed they had armed it, and the
 * only evidence would be the very push they were trying to prevent.
 */
export function parseByteCeiling(raw: string | undefined, envName: string): number | undefined {
  const text = (raw ?? "").trim();
  if (text === "") return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `${envName} must be a positive number of bytes, got ${JSON.stringify(text)}. ` +
        `Digits only: use 1000000000, not 1_000_000_000 or 2GB.`,
    );
  }
  return n;
}

/**
 * Exclude patterns that matched nothing, so a typo does not pass for a skip.
 *
 * Usually a full `/nix/store/...` path pasted where a NAME glob belongs, which
 * can never match. Takes the patterns already known to have matched rather than
 * re-deriving them, so a caller with several builds can accumulate across all of
 * them: a pattern aimed at one output would otherwise warn on every other one.
 */
export function unmatchedPatterns(
  exclude: readonly string[],
  matched: ReadonlySet<string>,
): string[] {
  return exclude.filter((p) => p.trim() !== "" && !matched.has(p));
}

/** The exclude patterns that dropped at least one path in this plan. */
export function matchedPatterns(exclude: readonly string[], plan: UploadPlan): Set<string> {
  const names = plan.skippedByPolicy
    .filter((e) => e.reason === "excluded")
    .map((e) => storePathName(e.path));
  return new Set(exclude.filter((p) => names.some((n) => globMatches(p, n))));
}
