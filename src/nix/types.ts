/**
 * Core Nix binary-cache types.
 *
 * These model the on-the-wire artifacts that the `nix` client fetches from a
 * substituter over the HTTP binary cache protocol:
 *
 *   - `/nix-cache-info`        -> {@link CacheInfo}
 *   - `/{hash}.narinfo`        -> {@link NarInfo}
 *   - `/{narinfo.url}`         -> the NAR file (bytes; not modelled here)
 *
 * Spec references:
 *   - https://fzakaria.com/2021/08/12/a-nix-binary-cache-specification.html
 *   - https://wiki.nixos.org/wiki/Binary_Cache
 *   - Nix source: src/libstore/path-info.cc (fingerprint), narinfo.cc (format)
 */

/** Absolute store path, e.g. `/nix/store/<hash>-<name>`. */
export type StorePath = string;

/**
 * A hash in Nix's canonical textual form: `<algo>:<digest>`, where for narinfo
 * the algo is `sha256` and the digest is Nix-base32 (NOT standard base32 or
 * hex). We treat it as an opaque, already-formatted string: the signing
 * fingerprint embeds it verbatim, so we never re-encode it.
 */
export type NixHash = string;

/**
 * Contents of `/nix-cache-info`.
 *
 * `storeDir` MUST match the client's store dir (`/nix/store`) or the client
 * refuses the cache. `priority` lower = preferred. `wantMassQuery` advertises
 * that `.narinfo` HEAD/GET is cheap enough for bulk queries.
 */
export interface CacheInfo {
  storeDir: StorePath;
  wantMassQuery: boolean;
  priority: number;
}

/**
 * Parsed `.narinfo`.
 *
 * `references` and `deriver` are stored as BASE NAMES (no `/nix/store/`
 * prefix), exactly as they appear on the wire. The signing fingerprint
 * re-adds the store dir prefix — see {@link fingerprint}.
 */
export interface NarInfo {
  /** Full store path this narinfo describes. */
  storePath: StorePath;
  /** Relative URL of the NAR, e.g. `nar/<filehash>.nar.zst`. */
  url: string;
  /** Compression of the NAR at `url`: `none`, `xz`, `zstd`, ... */
  compression: string;
  /** Hash of the COMPRESSED NAR at `url` (the file actually served). */
  fileHash: NixHash;
  /** Size in bytes of the compressed NAR at `url`. */
  fileSize: number;
  /** Hash of the UNCOMPRESSED NAR. Part of the signed fingerprint. */
  narHash: NixHash;
  /** Size in bytes of the uncompressed NAR. Part of the signed fingerprint. */
  narSize: number;
  /** Reference base names (no store-dir prefix). Part of the fingerprint. */
  references: string[];
  /** Deriver base name (no store-dir prefix), if known. */
  deriver?: string;
  /** Signatures, each `<keyName>:<base64(sig)>`. */
  sigs: string[];
}

/**
 * An ed25519 keypair in Nix's serialized form.
 *
 *   secret key file:  `<name>:<base64(64-byte libsodium secret key)>`
 *   public key:       `<name>:<base64(32-byte public key)>`
 *
 * The 64-byte secret is `seed(32) || publicKey(32)` (libsodium layout); we sign
 * with the 32-byte seed. The `name` is the signature key id that appears in the
 * narinfo `Sig:` line and in the client's `trusted-public-keys`.
 */
export interface NixSecretKey {
  name: string;
  /** 32-byte ed25519 seed (first half of the libsodium secret key). */
  seed: Uint8Array;
}

export interface NixPublicKey {
  name: string;
  /** 32-byte ed25519 public key. */
  key: Uint8Array;
}
