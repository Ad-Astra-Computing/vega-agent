import { sha256NixBase32Stream } from "./hash.js";
import type { NixHash } from "./types.js";

export interface NarHashVerification {
  ok: boolean;
  /** The claimed (signed) narHash. */
  expected: NixHash;
  /** The narHash re-derived from the actual uncompressed NAR content. */
  actual: NixHash;
}

/**
 * Re-derive a NAR's hash from its uncompressed bytes and compare to the claim.
 *
 * This is the core of the independent verifier: an external auditor of the cache
 * that catches entries whose stored NAR does not decompress to content matching
 * the signed `narHash` — corruption, or an internally-consistent-but-wrong
 * claim that would otherwise only surface as a client-side substitution failure.
 * It is a consistency/quality check, not the trust anchor (that is the
 * distinct-tenant agreement); keep it off the Worker hot path.
 */
export async function verifyNarHash(
  claimedNarHash: NixHash,
  uncompressedNar: Uint8Array | ReadableStream<Uint8Array>,
): Promise<NarHashVerification> {
  const actual = await sha256NixBase32Stream(uncompressedNar);
  return { ok: actual === claimedNarHash, expected: claimedNarHash, actual };
}
