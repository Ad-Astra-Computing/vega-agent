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

/**
 * Is the exact compressed NAR object already present at `readBase`? Used to
 * resume a re-run after a timeout/mid-upload failure by skipping the PUT of a
 * NAR that a prior run of THIS build already uploaded.
 *
 * Crucially this probes the CONTENT-ADDRESSED object key (`nar/<fileHash>.nar.zst`,
 * see {@link makeNar}), not the store-path narinfo. A 200 there means the bytes
 * we are about to upload are already stored, byte-for-byte, so the PUT is a
 * genuine no-op. Probing the store-path narinfo instead would be unsound: an
 * input-addressed store path can have divergent NAR contents, so its presence is
 * not proof of identical bytes, and skipping on it could suppress a fresh (or
 * reproducer) build's evidence. This only ever skips the redundant upload; the
 * caller still always attests the locally built output.
 *
 * Fail-open: any error/timeout/non-200 returns false, so a transient probe
 * failure re-uploads (safe) rather than dropping the object.
 */
export async function narObjectExists(
  readBase: string,
  narUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const base = readBase.replace(/\/$/, "");
  try {
    const res = await fetchImpl(`${base}/${narUrl}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}
