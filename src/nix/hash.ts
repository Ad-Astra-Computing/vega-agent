import { sha256 } from "@noble/hashes/sha2.js";
import { encodeNixBase32, decodeNixBase32 } from "./nixbase32.js";
import type { NixHash } from "./types.js";

/** A well-formed `sha256:<52-char nixbase32>` string (32-byte digest). */
const SHA256_NIXBASE32 = /^sha256:[0123456789abcdfghijklmnpqrsvwxyz]{52}$/;

export function isSha256NixHash(s: string): boolean {
  return SHA256_NIXBASE32.test(s);
}

/** The raw 32 digest bytes of a `sha256:<nixbase32>` hash (throws if malformed). */
export function sha256NixHashToBytes(h: string): Uint8Array {
  if (!isSha256NixHash(h)) throw new Error("not a sha256:<nixbase32> hash");
  return decodeNixBase32(h.slice("sha256:".length));
}

/**
 * The digest of a `sha256:<nixbase32>` hash as standard base64 — the value form
 * R2/S3 expect in the `x-amz-checksum-sha256` header, so R2 verifies the upload
 * against it and stores the SHA-256 (letting the edge verify fileHash at attest
 * without re-hashing the NAR on the Worker).
 */
export function sha256NixHashToBase64(h: string): string {
  const bytes = sha256NixHashToBytes(h);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
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
