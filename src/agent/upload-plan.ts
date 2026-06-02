import { partitionByUpstream } from "./upstream.js";

export interface UploadPlan {
  /** Store paths to compress, upload, and attest. */
  toUpload: string[];
  /** Paths the upstream cache already serves (no value re-uploading stock nixpkgs). */
  skippedUpstream: string[];
}

/**
 * Decide which of a build closure's paths need processing at all.
 *
 * The only plan-time skip is `upstreamUrl`: drop paths the upstream cache
 * (cache.nixos.org) already serves, since a system closure is mostly stock
 * nixpkgs and there is no value in re-uploading or re-attesting it. The probe
 * fails a path into "upload" on any error (see {@link partitionByUpstream}), so a
 * transient failure never silently drops a path from the cache.
 *
 * Resumability (skipping a NAR a prior run of this build already uploaded) is
 * NOT decided here, because it must not drop a path from attestation and must
 * key on the exact compressed bytes, not the store path. It is handled per-path
 * at upload time via {@link narObjectExists}: the locally built output is always
 * attested, and only the redundant content-addressed PUT is skipped.
 */
export async function planUploads(
  paths: readonly string[],
  opts: { upstreamUrl?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<UploadPlan> {
  let remaining = [...paths];
  let skippedUpstream: string[] = [];
  if (opts.upstreamUrl !== undefined) {
    const { novel, upstream } = await partitionByUpstream(remaining, opts.upstreamUrl, fetchImpl);
    remaining = novel;
    skippedUpstream = upstream;
  }
  return { toUpload: remaining, skippedUpstream };
}
