import type { NarInfo, StorePath } from "./types.js";

/** The store directory all vega builds target. */
export const STORE_DIR: StorePath = "/nix/store";

/**
 * Build the string that a narinfo signature is computed over.
 *
 * This MUST match Nix byte-for-byte. From `src/libstore/path-info.cc`:
 *
 *   "1;" + printStorePath(path) + ";"
 *        + narHash.to_string(Nix32, true) + ";"   // e.g. "sha256:<base32>"
 *        + to_string(narSize) + ";"
 *        + concatStringsSep(",", printStorePathSet(references))
 *
 * Notes that are easy to get wrong:
 *   - `references` on the wire are BASE NAMES; here they become FULL paths
 *     (store dir prefixed), comma-joined.
 *   - Nix's `printStorePathSet` emits the references SORTED (it is a std::set),
 *     so sort the full paths to match byte-for-byte. Nix always produces sorted
 *     References, so this is a no-op for well-formed input and a correction for
 *     an unsorted one.
 *   - With zero references the string ends in a trailing ";" (empty field).
 *   - `narHash` already carries its `sha256:` prefix and is embedded verbatim.
 */
export function fingerprint(info: NarInfo, storeDir: StorePath = STORE_DIR): string {
  const refs = info.references
    .map((r) => `${storeDir}/${r}`)
    .sort()
    .join(",");
  return `1;${info.storePath};${info.narHash};${info.narSize};${refs}`;
}
