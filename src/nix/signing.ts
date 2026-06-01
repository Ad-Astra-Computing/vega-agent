import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import type { NarInfo, NixPublicKey, NixSecretKey, StorePath } from "./types.js";
import { fingerprint, STORE_DIR } from "./fingerprint.js";

const utf8 = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  // Reject anything that is not strict standard base64; btoa/atob are lenient
  // about some inputs, so validate the alphabet and padding ourselves.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new Error("invalid base64");
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Split a Nix `<name>:<base64>` key string, validating shape. */
function splitKey(s: string): { name: string; bytes: Uint8Array } {
  const idx = s.indexOf(":");
  if (idx <= 0 || idx === s.length - 1) {
    throw new Error("malformed Nix key: expected `<name>:<base64>`");
  }
  return { name: s.slice(0, idx), bytes: fromBase64(s.slice(idx + 1)) };
}

/**
 * Parse a Nix secret key: `<name>:<base64(64-byte libsodium secret key)>`.
 * The 64 bytes are `seed(32) || publicKey(32)`; we keep the seed for signing.
 */
export function parseSecretKey(s: string): NixSecretKey {
  const { name, bytes } = splitKey(s);
  if (bytes.length !== 64) {
    throw new Error(`secret key must be 64 bytes, got ${bytes.length}`);
  }
  return { name, seed: bytes.slice(0, 32) };
}

/** Parse a Nix public key: `<name>:<base64(32-byte public key)>`. */
export function parsePublicKey(s: string): NixPublicKey {
  const { name, bytes } = splitKey(s);
  if (bytes.length !== 32) {
    throw new Error(`public key must be 32 bytes, got ${bytes.length}`);
  }
  return { name, key: bytes };
}

export function formatPublicKey(pk: NixPublicKey): string {
  return `${pk.name}:${toBase64(pk.key)}`;
}

/** Serialize a secret key back to Nix form (`seed || publicKey`). */
export function formatSecretKey(sk: NixSecretKey): string {
  const pub = ed25519.getPublicKey(sk.seed);
  const combined = new Uint8Array(64);
  combined.set(sk.seed, 0);
  combined.set(pub, 32);
  return `${sk.name}:${toBase64(combined)}`;
}

export interface GeneratedKeyPair {
  secret: NixSecretKey;
  public: NixPublicKey;
  secretKeyString: string;
  publicKeyString: string;
}

/**
 * Generate a fresh ed25519 keypair in Nix's serialized form.
 *
 * `seed` must be 32 cryptographically-random bytes; we use Web Crypto's
 * `getRandomValues`, available in both Workers and Node.
 */
export function generateKeyPair(name: string): GeneratedKeyPair {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const secret: NixSecretKey = { name, seed };
  const pub: NixPublicKey = { name, key: ed25519.getPublicKey(seed) };
  return {
    secret,
    public: pub,
    secretKeyString: formatSecretKey(secret),
    publicKeyString: formatPublicKey(pub),
  };
}

/** Derive the public key from a secret key (the seed's ed25519 public point). */
export function derivePublicKey(secret: NixSecretKey): NixPublicKey {
  return { name: secret.name, key: ed25519.getPublicKey(secret.seed) };
}

/** Sign an arbitrary message, returning `<name>:<base64(sig)>` (e.g. an STH). */
export function signBytes(key: NixSecretKey, message: Uint8Array): string {
  return `${key.name}:${toBase64(ed25519.sign(message, key.seed))}`;
}

/** Verify a {@link signBytes} signature against a public key. */
export function verifyBytes(pk: NixPublicKey, message: Uint8Array, sig: string): boolean {
  const idx = sig.indexOf(":");
  if (idx <= 0 || sig.slice(0, idx) !== pk.name) return false;
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64(sig.slice(idx + 1));
  } catch {
    return false;
  }
  if (sigBytes.length !== 64) return false;
  try {
    return ed25519.verify(sigBytes, message, pk.key);
  } catch {
    return false;
  }
}

/**
 * Derive a deterministic per-tenant signing key from the master secret. Used so
 * that a single tenant's attestation is signed with a tenant-scoped key, never
 * the globally trusted master key. The master seed has full entropy, so a
 * domain-separated SHA-256 is a sound KDF here. Same tenant always yields the
 * same key; different tenants yield independent keys.
 */
export function deriveTenantKey(master: NixSecretKey, tenant: string): NixSecretKey {
  const info = utf8.encode(`vega-tenant-key-v1:${tenant}`);
  const material = new Uint8Array(master.seed.length + info.length);
  material.set(master.seed, 0);
  material.set(info, master.seed.length);
  const name = `vega-${tenant.replace(/[^a-zA-Z0-9._-]/g, "-")}-1`;
  return { name, seed: sha256(material) };
}

/**
 * Derive the owner-lane enrollment signing key from the master key, so owner
 * credentials are signed with a key distinct from the cache's narinfo key (no
 * separate secret to manage). Domain-separated from {@link deriveTenantKey}.
 */
export function deriveEnrollKey(master: NixSecretKey): NixSecretKey {
  const info = utf8.encode("vega-enroll-key-v1");
  const material = new Uint8Array(master.seed.length + info.length);
  material.set(master.seed, 0);
  material.set(info, master.seed.length);
  return { name: "vega-enroll-1", seed: sha256(material) };
}

/**
 * Derive a PER-CONSUMER social view signing key from the master key. The
 * personalized `/u/<token>` view signs a consumer's graph-resolved bindings with
 * their own view key, never the master (shared) key and never a key shared with
 * other consumers. A distinct key per consumer is what stops a binding signed for
 * one consumer from being accepted by another: only that consumer trusts
 * `vega-view-<id>-1`. Domain-separated from {@link deriveTenantKey} and
 * {@link deriveEnrollKey}; the consumer's Nix tells "Vega reproduced this"
 * (shared key) from "my graph resolved this" (my view key) by the key name.
 */
export function deriveSocialKey(master: NixSecretKey, consumer: string): NixSecretKey {
  const info = utf8.encode(`vega-social-key-v1:${consumer}`);
  const material = new Uint8Array(master.seed.length + info.length);
  material.set(master.seed, 0);
  material.set(info, master.seed.length);
  const name = `vega-view-${consumer.replace(/[^a-zA-Z0-9._-]/g, "-")}-1`;
  return { name, seed: sha256(material) };
}

/**
 * Sign a narinfo, returning a `Sig:` value of the form `<name>:<base64(sig)>`.
 */
export function signNarInfo(
  info: NarInfo,
  key: NixSecretKey,
  storeDir: StorePath = STORE_DIR,
): string {
  const msg = utf8.encode(fingerprint(info, storeDir));
  const sig = ed25519.sign(msg, key.seed);
  return `${key.name}:${toBase64(sig)}`;
}

/**
 * Verify a narinfo signature against a public key.
 *
 * Returns false (never throws) for any mismatch: wrong key name, malformed
 * signature, or a fingerprint that does not match the signed bytes. The key
 * name in the signature must equal the public key's name — a signature only
 * means something relative to the key id the client trusts.
 */
export function verifyNarInfo(
  info: NarInfo,
  sig: string,
  pk: NixPublicKey,
  storeDir: StorePath = STORE_DIR,
): boolean {
  const idx = sig.indexOf(":");
  if (idx <= 0) return false;
  const name = sig.slice(0, idx);
  if (name !== pk.name) return false;
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64(sig.slice(idx + 1));
  } catch {
    return false;
  }
  if (sigBytes.length !== 64) return false;
  const msg = utf8.encode(fingerprint(info, storeDir));
  try {
    return ed25519.verify(sigBytes, msg, pk.key);
  } catch {
    return false;
  }
}
