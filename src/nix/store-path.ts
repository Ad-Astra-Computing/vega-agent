import type { StorePath } from "./types.js";

const STORE_PATH = /^\/nix\/store\/([0-9abcdfghijklmnpqrsvwxyz]{32})-[^/\n]+$/;

/**
 * Extract the 32-char Nix-base32 hash from a store path. This hash is the
 * `.narinfo` object key and the Durable Object name for the output, so the
 * cache read path, write path, and attestation tally all address the same DO.
 */
export function storePathHash(path: StorePath): string {
  const m = STORE_PATH.exec(path);
  if (m === null) throw new Error(`not a /nix/store path: ${path}`);
  return m[1]!;
}
