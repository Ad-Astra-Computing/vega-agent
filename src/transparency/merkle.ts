/**
 * RFC 9162 (Certificate Transparency) Merkle tree: the cryptographic core of
 * Vega's append-only transparency log. Leaf and node hashing use the prefixed
 * forms so that a leaf can never be reinterpreted as an interior node:
 *
 *   leaf hash   = SHA-256(0x00 || data)
 *   node hash   = SHA-256(0x01 || left || right)
 *   empty tree  = SHA-256()
 *
 * Verification (inclusion / consistency) follows the trillian decomposition so
 * a client can check a proof from just (index, treeSize, proof, root).
 */

import { sha256 } from "@noble/hashes/sha2.js";

export function leafHash(data: Uint8Array): Uint8Array {
  const m = new Uint8Array(1 + data.length);
  m[0] = 0x00;
  m.set(data, 1);
  return sha256(m);
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  const m = new Uint8Array(1 + left.length + right.length);
  m[0] = 0x01;
  m.set(left, 1);
  m.set(right, 1 + left.length);
  return sha256(m);
}

/** Largest power of two strictly less than n (the RFC 9162 split point). */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** Merkle Tree Hash over a list of leaf *data* blobs. */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  const n = leaves.length;
  if (n === 0) return sha256(new Uint8Array(0));
  if (n === 1) return leafHash(leaves[0]!);
  const k = splitPoint(n);
  return nodeHash(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

/** Audit path proving the leaf at `index` is in the tree of `leaves`. */
export function inclusionProof(leaves: readonly Uint8Array[], index: number): Uint8Array[] {
  const n = leaves.length;
  if (index < 0 || index >= n) throw new Error("index out of range");
  if (n === 1) return [];
  const k = splitPoint(n);
  if (index < k) {
    return [...inclusionProof(leaves.slice(0, k), index), merkleRoot(leaves.slice(k))];
  }
  return [...inclusionProof(leaves.slice(k), index - k), merkleRoot(leaves.slice(0, k))];
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function bitLength(x: number): number {
  let n = 0;
  while (x > 0) {
    x = Math.floor(x / 2);
    n++;
  }
  return n;
}

function popcount(x: number): number {
  let c = 0;
  while (x > 0) {
    c += x % 2;
    x = Math.floor(x / 2);
  }
  return c;
}

function trailingZeros(x: number): number {
  if (x === 0) return 0;
  let n = 0;
  while (x % 2 === 0) {
    x = Math.floor(x / 2);
    n++;
  }
  return n;
}

function chainInner(seed: Uint8Array, proof: readonly Uint8Array[], index: number): Uint8Array {
  let h = seed;
  for (let i = 0; i < proof.length; i++) {
    const bit = Math.floor(index / 2 ** i) % 2;
    h = bit === 0 ? nodeHash(h, proof[i]!) : nodeHash(proof[i]!, h);
  }
  return h;
}

function chainInnerRight(seed: Uint8Array, proof: readonly Uint8Array[], index: number): Uint8Array {
  let h = seed;
  for (let i = 0; i < proof.length; i++) {
    if (Math.floor(index / 2 ** i) % 2 === 1) h = nodeHash(proof[i]!, h);
  }
  return h;
}

function chainBorderRight(seed: Uint8Array, proof: readonly Uint8Array[]): Uint8Array {
  let h = seed;
  for (const p of proof) h = nodeHash(p, h);
  return h;
}

/** RFC 9162 consistency sub-proof over leaf data. */
function subProof(m: number, leaves: readonly Uint8Array[], complete: boolean): Uint8Array[] {
  const n = leaves.length;
  if (m === n) return complete ? [] : [merkleRoot(leaves)];
  const k = splitPoint(n);
  if (m <= k) {
    return [...subProof(m, leaves.slice(0, k), complete), merkleRoot(leaves.slice(k))];
  }
  return [...subProof(m - k, leaves.slice(k), false), merkleRoot(leaves.slice(0, k))];
}

/** Prove the tree of the first `m` leaves is a prefix of the full tree. */
export function consistencyProof(leaves: readonly Uint8Array[], m: number): Uint8Array[] {
  if (m <= 0 || m > leaves.length) throw new Error("m out of range");
  if (m === leaves.length) return [];
  return subProof(m, leaves, true);
}

/**
 * Verify a consistency proof: that the tree of `size1` leaves (root `root1`) is
 * an append-only prefix of the tree of `size2` leaves (root `root2`). This is
 * the property that makes the log tamper-evident: history can only grow.
 */
export function verifyConsistency(
  size1: number,
  size2: number,
  proof: readonly Uint8Array[],
  root1: Uint8Array,
  root2: Uint8Array,
): boolean {
  if (size1 > size2) return false;
  if (size1 === size2) return proof.length === 0 && equal(root1, root2);
  if (size1 === 0) return proof.length === 0;

  let inner = bitLength(((size1 - 1) ^ (size2 - 1)) >>> 0);
  const border = popcount(Math.floor((size1 - 1) / 2 ** inner));
  const shift = trailingZeros(size1);
  inner -= shift;

  let seed: Uint8Array;
  let start: number;
  if (size1 === 2 ** shift) {
    seed = root1;
    start = 0;
  } else {
    if (proof.length === 0) return false;
    seed = proof[0]!;
    start = 1;
  }
  if (proof.length !== start + inner + border) return false;
  const p = proof.slice(start);
  const mask = Math.floor((size1 - 1) / 2 ** shift);

  const hash1 = chainBorderRight(chainInnerRight(seed, p.slice(0, inner), mask), p.slice(inner));
  const hash2 = chainBorderRight(chainInner(seed, p.slice(0, inner), mask), p.slice(inner));
  return equal(hash1, root1) && equal(hash2, root2);
}

/**
 * Verify an inclusion proof: recompute the root from the leaf hash and audit
 * path, using the trillian decomposition of (index, treeSize). Returns false
 * for any mismatch.
 */
export function verifyInclusion(
  leaf: Uint8Array,
  index: number,
  treeSize: number,
  proof: readonly Uint8Array[],
  root: Uint8Array,
): boolean {
  if (index < 0 || index >= treeSize) return false;
  const inner = bitLength((index ^ (treeSize - 1)) >>> 0);
  const border = popcount(Math.floor(index / 2 ** inner));
  if (proof.length !== inner + border) return false;

  let h = leaf;
  for (let i = 0; i < inner; i++) {
    const bit = Math.floor(index / 2 ** i) % 2;
    h = bit === 0 ? nodeHash(h, proof[i]!) : nodeHash(proof[i]!, h);
  }
  for (let j = inner; j < proof.length; j++) {
    h = nodeHash(proof[j]!, h);
  }
  return equal(h, root);
}
