/**
 * Client-side secret scanning for the build agent. Before publishing a build's
 * output to Vega, scan its text for credentials that should never be cached
 * (private keys, cloud access keys, service tokens). It is WARN-by-default and
 * opt-out via `vega.yaml` (`secretScan: false`); a build cached to a public,
 * append-only, content-addressed store is effectively un-deletable, so warning
 * before upload is the only point a leak can still be caught.
 *
 * Detection is by SPECIFIC, well-known credential formats, never generic
 * entropy: a NAR is full of high-entropy base32 store-path hashes, so an entropy
 * scanner would be unusable. Specific patterns keep false positives near zero.
 */

import { readdir, readFile, stat, lstat } from "node:fs/promises";
import { join } from "node:path";

export interface SecretFinding {
  /** The detector that matched (e.g. "github-token"). */
  kind: string;
  /** 1-based line number of the match. */
  line: number;
  /** A redacted preview of the match; never the secret verbatim. */
  preview: string;
}

interface Detector {
  kind: string;
  re: RegExp;
}

// Each pattern targets a distinct, recognizable credential shape. Kept narrow on
// purpose: a false positive that blocks a publish is worse than missing an exotic
// format, and the user can always disable the scan.
const DETECTORS: Detector[] = [
  { kind: "private-key", re: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/ },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "stripe-key", re: /\bsk_live_[0-9a-zA-Z]{24,}\b/ },
];

/** Show only enough of a match to recognize it; never the full secret. */
function redact(match: string): string {
  return match.length <= 8 ? "***" : `${match.slice(0, 6)}…`;
}

/**
 * Redact any known-credential substrings inside arbitrary text, reusing the same
 * detectors. A build's OWN file PATH can embed a token (a derivation may name a
 * file `$out/ghp_<...>`); a finding's `file` is logged verbatim, so redact the
 * path too rather than printing the secret in CI logs.
 */
export function redactKnownSecrets(text: string): string {
  let out = text;
  for (const d of DETECTORS) {
    const g = new RegExp(d.re.source, d.re.flags.includes("g") ? d.re.flags : `${d.re.flags}g`);
    out = out.replace(g, (m) => redact(m));
  }
  return out;
}

/** Scan text for known credential formats, one finding per matching detector
 * per line. Pure and synchronous so it is trivially testable. */
export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const d of DETECTORS) {
      const m = d.re.exec(line);
      if (m !== null) findings.push({ kind: d.kind, line: i + 1, preview: redact(m[0]) });
    }
  }
  return findings;
}

export interface PathFinding extends SecretFinding {
  /** Absolute path of the file the secret was found in. */
  file: string;
}

/** Skip files larger than this (data blobs / unlikely to be hand-placed secrets). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Bound the walk: a malicious output could pack millions of tiny files or deep
 * trees. Stop after this many files scanned or findings collected (warn-only, so
 * a partial scan that hits the cap is still useful and never blocks the build). */
const MAX_FILES = 50_000;
const MAX_FINDINGS = 1000;

/**
 * Walk a built store path and scan its TEXT files for secrets. Symlinks are not
 * followed (so we scan the build's own output, not its dependency closure),
 * binaries (any NUL byte) and oversized/empty files are skipped. The fs walk is
 * the Node-only boundary; the detection itself is the pure {@link scanForSecrets}.
 */
export async function scanStorePath(root: string): Promise<PathFinding[]> {
  const out: PathFinding[] = [];
  let filesScanned = 0;
  const capped = (): boolean => filesScanned >= MAX_FILES || out.length >= MAX_FINDINGS;
  const scanFile = async (p: string): Promise<void> => {
    if (capped()) return;
    filesScanned++;
    let size: number;
    try {
      size = (await stat(p)).size;
    } catch {
      return;
    }
    if (size === 0 || size > MAX_FILE_BYTES) return;
    let buf: Buffer;
    try {
      buf = await readFile(p);
    } catch {
      return;
    }
    if (buf.includes(0)) return; // binary
    for (const f of scanForSecrets(buf.toString("utf8"))) {
      if (out.length >= MAX_FINDINGS) break; // a single file can hold many matches
      out.push({ ...f, file: p });
    }
  };
  const walk = async (dir: string): Promise<void> => {
    if (capped()) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (capped()) return;
      if (e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) await scanFile(p);
    }
  };
  // A store output can be a regular FILE (e.g. a `writeText`/`runCommand`
  // package that writes $out as a file) or a directory; scan either. (A naive
  // readdir(root) throws ENOTDIR on a file output, silently scanning nothing.)
  // Use lstat, not stat: if the output is itself a symlink, do NOT follow it into
  // the dependency closure (matching the in-walk symlink skip).
  let st;
  try {
    st = await lstat(root);
  } catch {
    return out;
  }
  if (st.isSymbolicLink()) return out;
  if (st.isFile()) await scanFile(root);
  else if (st.isDirectory()) await walk(root);
  return out;
}
