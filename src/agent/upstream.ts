import { storePathHash } from "../nix/store-path.js";

/**
 * Split a build closure into paths the upstream cache (e.g. cache.nixos.org)
 * already has and the genuinely novel ones. Caching only the novel paths is what
 * keeps uploads small: a NixOS system closure is mostly stock nixpkgs that
 * upstream already serves, so there is no value in re-uploading it to Vega.
 *
 * A path counts as upstream only on a definite 200 for its `.narinfo`; any
 * network error leaves it in `novel` so a transient upstream failure makes us
 * upload (safe) rather than silently drop a path from the cache.
 */
export async function partitionByUpstream(
  paths: readonly string[],
  upstreamUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ novel: string[]; upstream: string[] }> {
  const base = upstreamUrl.replace(/\/$/, "");
  const novel: string[] = [];
  const upstream: string[] = [];
  for (const path of paths) {
    let inUpstream = false;
    try {
      const res = await fetchImpl(`${base}/${storePathHash(path)}.narinfo`, { method: "HEAD" });
      inUpstream = res.status === 200;
    } catch {
      inUpstream = false;
    }
    (inUpstream ? upstream : novel).push(path);
  }
  return { novel, upstream };
}
