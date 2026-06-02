import { partitionByUpstream } from "./upstream.js";

export interface UploadPlan {
  /** Store paths to compress, upload, and attest. */
  toUpload: string[];
  /** Paths the upstream cache already serves (no value re-uploading stock nixpkgs). */
  skippedUpstream: string[];
  /** Paths already in this tenant from a prior run (resumability). */
  skippedResume: string[];
}

/**
 * Decide which of a build closure's paths actually need uploading.
 *
 * Two skips, each a `.narinfo` presence probe (see {@link partitionByUpstream},
 * which fails a path into "upload" on any error so a transient probe never drops
 * it from the cache):
 *  - `upstreamUrl`: drop paths the upstream cache (cache.nixos.org) already
 *    serves; a system closure is mostly stock nixpkgs, so this keeps uploads small.
 *  - `resumeUrl`: drop paths already in THIS tenant from a prior run. A long
 *    build whose job timed out or failed mid-upload can be re-run and only does
 *    the remaining paths, instead of re-uploading the whole closure. The resume
 *    probe runs over the (small) post-upstream set, so it is cheap.
 *
 * Store paths are content/input-addressed, so a path already present is byte-for
 * byte the same one we would upload; skipping it is correct, not just an
 * optimization.
 */
export async function planUploads(
  paths: readonly string[],
  opts: { upstreamUrl?: string; resumeUrl?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<UploadPlan> {
  let remaining = [...paths];
  let skippedUpstream: string[] = [];
  if (opts.upstreamUrl !== undefined) {
    const { novel, upstream } = await partitionByUpstream(remaining, opts.upstreamUrl, fetchImpl);
    remaining = novel;
    skippedUpstream = upstream;
  }
  let skippedResume: string[] = [];
  if (opts.resumeUrl !== undefined) {
    const { novel, upstream } = await partitionByUpstream(remaining, opts.resumeUrl, fetchImpl);
    remaining = novel;
    skippedResume = upstream;
  }
  return { toUpload: remaining, skippedUpstream, skippedResume };
}
