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
 * flake ref pins the revision with `?rev=<rev>`.
 */
export function lockedInstallable(p: BuildProvenance): string {
  const rev = encodeURIComponent(p.rev);
  const out = /^github:[^/]+\/[^/?#]+$/.test(p.flakeRef)
    ? `${p.flakeRef}/${rev}#${p.attr}`
    : `${p.flakeRef}${p.flakeRef.includes("?") ? "&" : "?"}rev=${rev}#${p.attr}`;
  // Defense in depth alongside the `--` terminator in nix.ts: never hand nix an
  // installable that would parse as an option flag.
  if (out.startsWith("-")) {
    throw new Error(`refusing installable that looks like a flag: ${out}`);
  }
  return out;
}
