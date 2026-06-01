import type { AttestBody } from "./client.js";
import { STORE_DIR } from "../nix/fingerprint.js";

/** Output of `nix path-info --json` for one path (the fields we consume). */
export interface RawPathInfo {
  path: string;
  /** Uncompressed NAR hash, already in `sha256:<nixbase32>` form. */
  narHash: string;
  narSize: number;
  /** Full store paths. */
  references: string[];
  /** Full store path of the deriver, or null/absent if unknown. */
  deriver?: string | null;
}

/** Facts about the compressed NAR the agent produced and is uploading. */
export interface NarArtifact {
  /** Relative key, e.g. `nar/<filehash>.nar.zst`. */
  url: string;
  compression: string;
  /** Hash of the compressed NAR at `url`, `sha256:<nixbase32>`. */
  fileHash: string;
  fileSize: number;
}

/** Strip the `/nix/store/` prefix to a base name (narinfo wire form). */
function baseName(path: string): string {
  const prefix = `${STORE_DIR}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Assemble an attest request body from `nix path-info` output and the NAR
 * artifact. References and deriver are reduced to base names, matching how the
 * control plane re-expands them when reconstructing the signing fingerprint.
 *
 * `attr` is the flake attribute that built this output, supplied only for the
 * top-level output the agent built (closure dependencies have no single attr).
 */
export function buildAttestBody(
  info: RawPathInfo,
  nar: NarArtifact,
  attr?: string,
  opts: { noContinent?: boolean } = {},
): AttestBody {
  const body: AttestBody = {
    storePath: info.path,
    url: nar.url,
    compression: nar.compression,
    fileHash: nar.fileHash,
    fileSize: nar.fileSize,
    narHash: info.narHash,
    narSize: info.narSize,
    references: info.references.map(baseName),
  };
  if (info.deriver) body.deriver = baseName(info.deriver);
  if (attr !== undefined && attr !== "") body.attr = attr;
  if (opts.noContinent) body.noContinent = true;
  return body;
}
