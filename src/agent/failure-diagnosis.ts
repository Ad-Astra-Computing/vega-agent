/**
 * Classifying a dispatched reproduction's failed build output for the producer,
 * and cutting a bounded, redacted excerpt of it.
 *
 * A build's own stderr is attacker-influenced: it can name another project's
 * derivation, print text shaped like one of these labels, or carry a secret.
 * So classification here is a set of narrow, specific patterns rather than
 * anything that trusts the text, and `other` is the answer whenever nothing
 * matches confidently (see docs/specs/0002-reproduction-diagnosis.md). This is
 * distinct from `repro-failure.ts`, which answers a different, narrower
 * question (can the provenance ever resolve) for the retirement ladder.
 */

import { redactKnownSecrets } from "./secret-scan.js";

export type Diagnosis =
  | "impure-host-path"
  | "sandbox-denied"
  | "network"
  | "out-of-space"
  | "timeout"
  | "eval"
  | "other";

export interface FailureDiagnosis {
  /** The failing derivation's store path, only when identified with confidence. */
  drv?: string;
  diagnosis: Diagnosis;
  /** A bounded, redacted excerpt of the build's output, when one could be built. */
  excerpt?: string;
}

// A pathological log must not make classification slow or allocate without
// bound. Nix's own failure line is always near the end of its output, so
// bounding to the tail loses nothing a real build would need.
const MAX_INPUT_CHARS = 2_000_000;

function boundInput(text: string): string {
  if (text.length <= MAX_INPUT_CHARS) return text;
  let start = text.length - MAX_INPUT_CHARS;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start++; // don't split a surrogate pair
  return text.slice(start);
}

// A build failure nix itself reports always says so in these words; an eval
// error never does. Checked first so a build's own printed text cannot forge
// its way into the `eval` label by echoing one of the patterns below.
const BUILD_FAILURE_PHRASE = /\b(?:builder for|build of) '[^']+' failed/i;

// A host executable directory at the START of a path, never one that happens to
// sit inside a store path: every /nix/store entry contains /bin/, so a pattern
// that matches anywhere calls an ordinary compiler invocation impure.
const HOST_EXEC = /(?:^|[\s'"(=:>])(?:\/usr\/bin\/|\/usr\/libexec\/|\/usr\/sbin\/|\/bin\/|\/sbin\/)[^\s'":]+/m;
const HOST_DENIAL = /(no such file or directory|permission denied|operation not permitted|command not found)/i;

function isImpureHostPath(text: string): boolean {
  if (!HOST_EXEC.test(text)) return false;
  // The denial has to be about the host path, not anywhere in the log. A
  // missing header file reported three hundred lines earlier is not evidence
  // that a build reached outside the store.
  return text.split("\n").some((line) => HOST_EXEC.test(line) && HOST_DENIAL.test(line));
}

const SANDBOX_PATTERNS = [
  /sandbox-fallback['" ]*.{0,40}(disabled|false)/i,
  /unable to (?:start|create) (?:child process|sandbox)/i,
  /failed to set up the build environment/i,
  /failed to set up.{0,20}chroot/i,
  /sandboxing.*not supported/i,
];

const NETWORK_PATTERNS = [
  /unable to download/i,
  /could ?n['’]?t (?:resolve|connect)/i,
  /temporary failure in name resolution/i,
  /name or service not known/i,
  /connection (?:refused|reset|timed out)/i,
  /network is unreachable/i,
];

const SPACE_PATTERNS = [/no space left on device/i, /\benospc\b/i, /disk quota exceeded/i];

// Nix's own words when it kills a build, not the word timeout wherever a test
// name or a log line happens to use it.
const TIMEOUT_PATTERNS = [
  /timed out after \d/i,
  /timed out because/i,
  /killed after \d+ seconds/i,
  /build timed out/i,
  /possible deadlock/i,
];

const EVAL_PATTERNS = [
  /error:.*does not provide attribute/i,
  /error:.*infinite recursion/i,
  /error:.*undefined variable/i,
  /error:.*attribute .* missing/i,
  /error:.*syntax error/i,
  /error:.*is not of type/i,
  /error:.*while evaluating/i,
];

function isEval(text: string): boolean {
  if (BUILD_FAILURE_PHRASE.test(text)) return false;
  return EVAL_PATTERNS.some((re) => re.test(text));
}

function detectDiagnosis(text: string): Diagnosis {
  if (isImpureHostPath(text)) return "impure-host-path";
  if (SANDBOX_PATTERNS.some((re) => re.test(text))) return "sandbox-denied";
  if (NETWORK_PATTERNS.some((re) => re.test(text))) return "network";
  if (SPACE_PATTERNS.some((re) => re.test(text))) return "out-of-space";
  if (TIMEOUT_PATTERNS.some((re) => re.test(text))) return "timeout";
  if (isEval(text)) return "eval";
  return "other";
}

// Nix's own base32 store-hash alphabet (matches src/nix/store-path.ts).
const DRV_ATTRIBUTED = /(?:builder for|build of) '(\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^'\n]+\.drv)'/;

/**
 * The failing derivation, taken only from nix's own failure line. A build
 * controls its stderr and this value becomes the grouping key a producer
 * reads, so a path the build merely printed is not evidence of anything and
 * is left out.
 */
function extractDrv(text: string): string | undefined {
  return DRV_ATTRIBUTED.exec(text)?.[1];
}

const EXCERPT_MAX_BYTES = 2048;

function lastErrorIndex(text: string): number {
  let idx = -1;
  const re = /error:/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) idx = m.index;
  return idx;
}

/**
 * Cut `chars` (already split into user-perceived characters) to at most
 * `maxBytes` of UTF-8, keeping the region closest to `anchorIdx` and never
 * splitting a character. Bounded to O(n): each pointer moves at most once per
 * character, and byte lengths are precomputed rather than re-measured on every
 * step, so a multi-megabyte excerpt input cannot make this quadratic.
 */
function cutAroundAnchor(chars: string[], anchorIdx: number, maxBytes: number): string {
  const byteLens = chars.map((c) => Buffer.byteLength(c, "utf8"));
  let total = byteLens.reduce((a, b) => a + b, 0);
  let s = 0;
  let e = chars.length;
  while (total > maxBytes) {
    const distStart = anchorIdx - s;
    const distEnd = e - anchorIdx;
    if (distEnd >= distStart) {
      e--;
      total -= byteLens[e]!;
    } else {
      total -= byteLens[s]!;
      s++;
    }
  }
  return chars.slice(s, e).join("");
}

// C0 and C1 controls (keep \n and \t), plus the Unicode bidirectional override
// and isolate characters, so neither a terminal nor a rendered page can be
// steered by text a build chose to print.
const CONTROL_AND_BIDI =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function stripControlAndBidi(text: string): string {
  return text.replace(CONTROL_AND_BIDI, "");
}

/**
 * Build the excerpt to send alongside a diagnosis: redact first, cut to at
 * most 2048 bytes of UTF-8 around the failure, then strip control and bidi
 * characters. The order is the security property: cutting first could split a
 * credential into a fragment the scanner no longer recognizes, leaking the
 * remaining half. If redaction cannot run, no excerpt is sent, ever.
 */
export function buildExcerpt(rawOutput: string): string | undefined {
  const bounded = boundInput(rawOutput);
  let redacted: string;
  try {
    redacted = redactKnownSecrets(bounded);
  } catch {
    return undefined;
  }
  if (redacted.length === 0) return undefined;
  const anchorStrIdx = lastErrorIndex(redacted);
  const chars = Array.from(redacted);
  const anchorIdx = anchorStrIdx === -1 ? chars.length : Array.from(redacted.slice(0, anchorStrIdx)).length;
  const cut = cutAroundAnchor(chars, anchorIdx, EXCERPT_MAX_BYTES);
  const stripped = stripControlAndBidi(cut);
  return stripped.length > 0 ? stripped : undefined;
}

/**
 * Classify a failed build's captured output into what the control plane
 * expects on `/api/repro/dispatch-failed`: a diagnosis label, the failing
 * derivation when one can be identified, and a bounded, redacted excerpt.
 *
 * The log is the only evidence. Nix reports a build failure as its own exit
 * code 100 whatever the builder did, so the builder's status is readable only
 * in the text, and reading a host-path incident out of an exit code would just
 * be a way to skip the check that keeps an ordinary compiler error mentioning
 * a `/usr` path from being called impure.
 */
export function classifyFailure(output: string): FailureDiagnosis {
  const bounded = boundInput(output);
  const diagnosis = detectDiagnosis(bounded);
  const drv = extractDrv(bounded);
  const excerpt = buildExcerpt(output);
  const result: FailureDiagnosis = { diagnosis };
  if (drv !== undefined) result.drv = drv;
  if (excerpt !== undefined) result.excerpt = excerpt;
  return result;
}
