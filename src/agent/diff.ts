/**
 * Pure helpers for `vega diff`: a local reproducibility check. `nix build
 * --rebuild` rebuilds an already-realised path and compares it to the stored
 * one; if they differ the build is non-reproducible, and `--keep-failed` leaves
 * the differing result at `<out>.check` so we can diff the two. The nix and
 * diffoscope shelling lives in `agent/diff.ts`; the arg-building and log-parsing
 * that is unit-testable lives here.
 */

/** Refuse an installable that would parse as a flag (defense in depth alongside
 * the `--` terminator). The installable is user-supplied, so a value like
 * `--store /evil` must never be read as an option. */
function assertNotFlag(installable: string): void {
  if (installable.startsWith("-")) {
    throw new Error(`refusing installable that looks like a flag: ${installable}`);
  }
}

/** Args to realise an installable and print its output path (build or
 * substitute). `--` terminates option parsing. */
export function buildArgs(installable: string): string[] {
  assertNotFlag(installable);
  return ["build", "--no-link", "--print-out-paths", "--", installable];
}

/** Args to rebuild locally and compare to the realised path. `--rebuild` forces
 * a fresh local build of an already-valid path and checks it against the stored
 * one; `--keep-failed` preserves the differing `<out>.check` for diffoscope;
 * `-L` streams build logs. `--` terminates option parsing. */
export function rebuildArgs(installable: string): string[] {
  assertNotFlag(installable);
  return ["build", "--rebuild", "--keep-failed", "-L", "--no-link", "--", installable];
}

export interface RebuildOutcome {
  /** True only when nix confirmed the rebuild matched the stored path. */
  reproducible: boolean;
  /** The realised output path; present only when a divergence was detected. */
  outPath?: string;
  /** The kept differing path `<out>.check`; present only on divergence. */
  checkPath?: string;
}

/** A `.check` store path in nix's `--rebuild` mismatch message. */
const CHECK_PATH = /(\/nix\/store\/[0-9a-z]{32}-\S+?\.check)\b/;

/**
 * Interpret a `nix build --rebuild` run.
 *
 *  - exit 0                       => reproducible.
 *  - non-zero + a kept `.check`   => diverged; returns both paths to diff.
 *  - non-zero + neither           => an ordinary build failure (NOT a
 *                                    divergence); the caller surfaces it as such
 *                                    (no checkPath, reproducible false).
 *
 * The divergence is recognised by nix's wording AND a kept `.check` path, so a
 * stray "differs" elsewhere in the log cannot be mistaken for a divergence.
 */
export function parseRebuild(log: string, exitCode: number): RebuildOutcome {
  if (exitCode === 0) return { reproducible: true };
  const nondeterministic = /may not be deterministic|differs from '/i.test(log);
  const m = CHECK_PATH.exec(log);
  if (nondeterministic && m) {
    const checkPath = m[1]!;
    return { reproducible: false, outPath: checkPath.replace(/\.check$/, ""), checkPath };
  }
  return { reproducible: false };
}
