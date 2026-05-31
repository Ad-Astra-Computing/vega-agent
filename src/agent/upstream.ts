import { storePathHash } from "../nix/store-path.js";

/** Per-path upstream probe timeout; a slow upstream classifies as novel, not a stall. */
const PROBE_TIMEOUT_MS = 15_000;

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
  concurrency = 64,
): Promise<{ novel: string[]; upstream: string[] }> {
  const base = upstreamUrl.replace(/\/$/, "");

  async function inUpstream(path: string): Promise<boolean> {
    try {
      // Bound each probe: a hung upstream must classify as novel (upload, safe)
      // rather than stall the whole partition. Any non-200/timeout/error -> novel.
      const res = await fetchImpl(`${base}/${storePathHash(path)}.narinfo`, {
        method: "HEAD",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  // A NixOS system closure is thousands of paths and each check is an
  // independent network round-trip, so probe in bounded-concurrency waves
  // rather than serially (which dominated agent wall-clock). Results stay
  // index-aligned with `paths`, so the partition preserves input order.
  const hit = new Array<boolean>(paths.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < paths.length; i = next++) {
      hit[i] = await inUpstream(paths[i]!);
    }
  };
  // Clamp to [1, paths.length]: a non-positive `concurrency` must not start zero
  // workers (which would mark everything novel without ever checking upstream).
  const workers = Math.min(Math.max(1, Math.floor(concurrency) || 1), Math.max(1, paths.length));
  await Promise.all(Array.from({ length: workers }, worker));

  const novel: string[] = [];
  const upstream: string[] = [];
  paths.forEach((path, i) => (hit[i] ? upstream : novel).push(path));
  return { novel, upstream };
}
