/**
 * Shared construction of a hardened {@link ToolContext} for the real cache, used
 * by both `vega mcp` (the stdio MCP server) and `vega assess` (the change gate).
 * Centralised so the bounded fetcher, timeouts, key resolution, and NAR re-hash
 * are identical across every entry point that talks to a live cache.
 */

import { parsePublicKey } from "../../src/nix/signing.js";
import { trustedKeys, pickTrustedKey } from "../keys.js";
import { withRetry, type Fetcher } from "../verify-core.js";
import { checkNarHash } from "../nar-check.js";
import type { ToolContext } from "./tools.js";
import type { NixPublicKey } from "../../src/nix/types.js";

export const SHARED_KEY_NAME = "vega-cache-1";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // narinfo/sth/entry/proof are tiny
const REQUEST_TIMEOUT_MS = 15_000; // small bodies; fail fast on a stalled cache
const NAR_TIMEOUT_MS = 120_000; // NARs can be large but must still terminate

/** A fetcher that aborts any response exceeding `maxBytes`, so a hostile cache
 * cannot exhaust memory by returning a giant narinfo/proof/entry body, and times
 * out a stalled response so a single call cannot hang. */
export function boundedFetcher(base: string, maxBytes: number): Fetcher {
  return async (path) => {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    let body: string | null = null;
    const read = async (): Promise<string> => {
      if (body !== null) return body;
      const reader = res.body?.getReader();
      if (!reader) return (body = "");
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error("response exceeds size limit");
        }
        chunks.push(value);
      }
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        buf.set(c, off);
        off += c.byteLength;
      }
      return (body = new TextDecoder().decode(buf));
    };
    return { ok: res.ok, status: res.status, text: read, json: async () => JSON.parse(await read()) };
  };
}

/** Build a read-only ToolContext bound to `cacheUrl`. The verification key comes
 * from an explicit flag or the user's nix.conf, NEVER from the cache. */
export function buildToolContext(
  cacheUrl: string,
  opts: { flagKey?: NixPublicKey | null; maxScan?: number } = {},
): ToolContext {
  const flagKey = opts.flagKey ?? null;
  return {
    fetcher: withRetry(boundedFetcher(cacheUrl, MAX_RESPONSE_BYTES)),
    cacheUrl,
    sharedKeyName: SHARED_KEY_NAME,
    ...(opts.maxScan !== undefined ? { maxScan: opts.maxScan } : {}),
    resolveKey: async (sigNames) => flagKey ?? pickTrustedKey(await trustedKeys(), sigNames),
    // Streaming NAR fetch (decompress + hash), bounded by a timeout rather than a
    // byte cap since a legitimate NAR can be large. A caller may pass a smaller
    // per-call timeout (the change gate does, to keep one in-flight NAR within
    // its wall-clock budget).
    verifyNar: (info, opts) =>
      checkNarHash(
        (p) => fetch(`${cacheUrl}${p}`, { signal: AbortSignal.timeout(opts?.timeoutMs ?? NAR_TIMEOUT_MS) }),
        info,
      ),
  };
}

/** Parse an explicit `--public-key` flag, or null when not given. Throws on a
 * malformed value so the caller can fail before doing any work. */
export function parseFlagKey(publicKey?: string): NixPublicKey | null {
  return publicKey ? parsePublicKey(publicKey) : null;
}
