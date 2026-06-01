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

const STORE_PATH_NAME = /^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-([^/\n]+)$/;

/**
 * Extract the name component of a store path: everything after the
 * `<hash>-` prefix (e.g. `hello-2.12.1`). Build-trust scopes match against this
 * name, so a consumer can trust a builder for `hello` without trusting them for
 * everything they publish.
 */
export function storePathName(path: StorePath): string {
  const m = STORE_PATH_NAME.exec(path);
  if (m === null) throw new Error(`not a /nix/store path: ${path}`);
  return m[1]!;
}
