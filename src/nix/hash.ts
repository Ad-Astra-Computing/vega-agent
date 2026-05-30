import { sha256 } from "@noble/hashes/sha2.js";
import { encodeNixBase32 } from "./nixbase32.js";
import type { NixHash } from "./types.js";

/** A well-formed `sha256:<52-char nixbase32>` string (32-byte digest). */
const SHA256_NIXBASE32 = /^sha256:[0123456789abcdfghijklmnpqrsvwxyz]{52}$/;

export function isSha256NixHash(s: string): boolean {
  return SHA256_NIXBASE32.test(s);
}

/** sha256 of `bytes`, formatted as `sha256:<nixbase32>` (narinfo hash form). */
export function sha256NixBase32(bytes: Uint8Array): NixHash {
  return `sha256:${encodeNixBase32(sha256(bytes))}`;
}

/**
 * Stream a body through sha256 and return `sha256:<nixbase32>`, without
 * buffering the whole thing — so large NARs from R2 stay within the isolate
 * memory cap. Accepts the in-memory and streaming `NarObject.body` shapes.
 */
export async function sha256NixBase32Stream(
  body: Uint8Array | ReadableStream<Uint8Array>,
): Promise<NixHash> {
  if (body instanceof Uint8Array) return sha256NixBase32(body);
  const hasher = sha256.create();
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) hasher.update(value);
  }
  return `sha256:${encodeNixBase32(hasher.digest())}`;
}
