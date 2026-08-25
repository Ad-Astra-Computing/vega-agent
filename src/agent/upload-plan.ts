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
 * `*` and `?` against a store path's NAME, anchored.
 *
 * The name, not the whole path: the hash changes on every rebuild, so a pattern
 * written against the full path would match once and never again. Everything
 * else is escaped, so a pattern is a glob and not an accidental regex.
 */
function globToRegExp(glob: string): RegExp {
  // Split on the wildcards so they survive, escape everything else, then map
  // them. Doing it with placeholder characters instead would break the moment a
  // pattern contained one.
  const body = glob
    .split(/([*?])/)
    .map((part) =>
      part === "*" ? ".*" : part === "?" ? "." : part.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${body}$`);
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
  const patterns = (opts.exclude ?? []).filter((p) => p.trim() !== "").map(globToRegExp);
  const cap = opts.maxNarBytes !== undefined && opts.maxNarBytes > 0 ? opts.maxNarBytes : undefined;

  const skippedByPolicy: SkippedPath[] = [];
  let remaining: PlanEntry[] = [];
  for (const e of closure) {
    if (patterns.some((re) => re.test(storePathName(e.path)))) {
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
