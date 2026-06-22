/**
 * Pure helpers for the reproducer (the layer-5 external builder). The reproducer
 * rebuilds a derivation someone else attested, under its own identity, and
 * attests the result; agreement on the fingerprint is what promotes the output
 * to the shared tier. The nix shelling lives in `../../agent/reproduce.ts`; the
 * payload/installable logic that is unit-testable lives here.
 */

import type { BuildProvenance } from "../trust/policy.js";

/**
 * Build the fully-locked installable a reproducer must rebuild from a
 * provenance record, so it evaluates to the same derivation the original build
 * did. `github:owner/repo` locks to `github:owner/repo/<rev>#<attr>`; any other
 * flake ref pins the revision with `?rev=<rev>`. A subflake `dir` (already
 * sanitized at ingest, see sanitizeFlakeDir) is added as a `dir=` parameter, so a
 * monorepo's subdirectory flake rebuilds as `<ref>/<rev>?dir=<dir>#<attr>`.
 */
export function lockedInstallable(p: BuildProvenance): string {
  // A flake ref must not already carry a fragment: we append `#<attr>` ourselves,
  // and a stray `#` would push the appended `?rev=`/`?dir=` into the fragment,
  // un-pinning the build. (`attr` is a separate field.)
  if (p.flakeRef.includes("#")) {
    throw new Error(`refusing flake ref with a fragment: ${p.flakeRef}`);
  }
  const rev = encodeURIComponent(p.rev);
  const isBareGithub = /^github:[^/?#]+\/[^/?#]+$/.test(p.flakeRef);
  // A subflake dir is only supported on a canonical bare `github:owner/repo` with
  // an immutable 40-hex commit SHA, where it composes onto the `/<rev>?dir=` form
  // the reproducer's containment check validates against the exact same tree.
  // Enforce both here too (not only at ingest and in the containment check) so a
  // direct/internal call can never form a mutable or non-canonical subflake build.
  if (p.dir !== undefined) {
    if (!isBareGithub) {
      throw new Error(`subflake dir is only supported on a canonical github ref: ${p.flakeRef}`);
    }
    if (!/^[0-9a-f]{40}$/i.test(p.rev)) {
      throw new Error(`subflake dir requires an immutable commit SHA rev: ${p.rev}`);
    }
  }
  let out: string;
  if (isBareGithub) {
    // The rev pins in the path; the subflake dir (if any) as a query param.
    out = `${p.flakeRef}/${rev}`;
    if (p.dir !== undefined) out += `?dir=${p.dir}`;
    out += `#${p.attr}`;
  } else {
    const sep = p.flakeRef.includes("?") ? "&" : "?";
    out = `${p.flakeRef}${sep}rev=${rev}#${p.attr}`;
  }
  // Defense in depth alongside the `--` terminator in nix.ts: never hand nix an
  // installable that would parse as an option flag.
  if (out.startsWith("-")) {
    throw new Error(`refusing installable that looks like a flag: ${out}`);
  }
  return out;
}
