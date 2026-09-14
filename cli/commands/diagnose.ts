import type { Command } from "commander";
import pc from "picocolors";
import { authHeaders, loadCredentialMaybe, safeError, type StoredCredential } from "../context.js";
import { star, info, warn, jsonEvent } from "../ui.js";

/** Exit codes for `vega diagnose`. Blocking-present-under-the-flag and an
 * auth/transport failure must never share a code, so a CI job can tell "the
 * query worked and found blockers" apart from "the query itself failed". */
export const EXIT_OK = 0;
export const EXIT_BLOCKING = 1;
export const EXIT_AUTH_OR_TRANSPORT_ERROR = 2;

/** One grouped entry from GET /api/repro/blocking: a failing
 * derivation, its classification, how many of the caller's own candidates it
 * blocks, and a bounded excerpt of the builder's own output. */
export interface BlockingGroup {
  drv: string;
  diagnosis: string;
  candidateCount: number;
  excerpt: string | null;
}

// Mirrors the closed set the control plane defines (edge/src/trust/registry-do.ts
// DIAGNOSIS_CLASSES). Duplicated rather than imported: the CLI and the edge
// Worker are separate packages with no shared runtime dependency, and an
// unrecognised value must still render as plain and harmless here, exactly as
// the server already stores it as "other" rather than trusting free text.
const DIAGNOSIS_LABELS: Readonly<Record<string, string>> = {
  "impure-host-path": "reaches a host path outside the Nix store",
  "sandbox-denied": "the sandbox denied something the build needed",
  network: "the build tried to reach the network",
  "out-of-space": "the builder ran out of disk space",
  timeout: "the build timed out",
  eval: "evaluation failed before any build ran",
  diverged: "rebuilt successfully, but to different bytes",
  other: "unclassified failure",
};

function diagnosisLabel(cls: string): string {
  return DIAGNOSIS_LABELS[cls] ?? DIAGNOSIS_LABELS.other!;
}

/**
 * Strip anything that can move the cursor or set a colour: ANSI escape
 * sequences, remaining C0/C1 controls, and bidi overrides. The control plane
 * strips the same classes before storage; this is the CLI's own wall, the
 * second one, since a JSON response is a different trust boundary than a row.
 */
// A full ANSI escape sequence (CSI, OSC, or a bare two-character form), so the
// parameter and final bytes go with the ESC that introduces them rather than
// being left behind as visible leftover text once the ESC alone is removed.
const ANSI_ESCAPE = /\x1b(?:\[[0-9:;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\^_])/g;

export function sanitizeForTerminal(text: string): string {
  return text
    .replace(ANSI_ESCAPE, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u202A-\u202E\u2066-\u2069]/g, "");
}

/** Defensively parse the response body: a malformed or partial group is
 * dropped rather than rendered half-formed, and nothing here trusts the
 * server's shape beyond checking it. */
export function parseGroups(body: unknown): BlockingGroup[] {
  if (typeof body !== "object" || body === null) return [];
  const groups = (body as Record<string, unknown>).groups;
  if (!Array.isArray(groups)) return [];
  const out: BlockingGroup[] = [];
  for (const g of groups) {
    if (typeof g !== "object" || g === null) continue;
    const r = g as Record<string, unknown>;
    if (typeof r.drv !== "string" || typeof r.diagnosis !== "string") continue;
    out.push({
      drv: r.drv,
      diagnosis: r.diagnosis,
      candidateCount: typeof r.candidateCount === "number" && Number.isFinite(r.candidateCount) ? r.candidateCount : 0,
      excerpt: typeof r.excerpt === "string" ? r.excerpt : null,
    });
  }
  return out;
}

/** One printable block for a group: the derivation, the cause in plain words,
 * how many candidates it blocks, and the excerpt attributed to the builder
 * (never presented as Vega's own words) and run through the terminal wall. */
export function formatGroup(g: BlockingGroup): string[] {
  const lines = [
    pc.bold(g.drv),
    `  cause:      ${diagnosisLabel(g.diagnosis)} (${pc.gray(g.diagnosis)})`,
    `  candidates: ${g.candidateCount}`,
  ];
  if (g.excerpt !== null && g.excerpt !== "") {
    lines.push("  from the builder's own output, not Vega's:");
    for (const line of sanitizeForTerminal(g.excerpt).split("\n")) {
      lines.push(pc.gray(`    | ${line}`));
    }
  }
  return lines;
}

/** Whether to exit 1 for this run: only `--fail-on-blocking` with at least
 * one group makes a successful query look like a failure to a caller. */
export function decideExit(groups: readonly BlockingGroup[], failOnBlocking: boolean): 0 | 1 {
  return failOnBlocking && groups.length > 0 ? EXIT_BLOCKING : EXIT_OK;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Fetch and parse the grouped view. Every failure path here is an "auth or
 * transport" outcome (missing/expired credential, network error, a non-2xx
 * response, or a body that isn't JSON) so the caller can map it to one exit
 * code without re-deriving what counts as that case. */
export async function fetchBlockingGroups(
  cred: StoredCredential | null,
  fetchImpl: FetchLike,
  now: () => number = Date.now,
): Promise<{ ok: true; groups: BlockingGroup[] } | { ok: false; message: string }> {
  if (cred === null) return { ok: false, message: "not enrolled: this machine has no Vega credential." };
  if (cred.expiresAt && cred.expiresAt < now()) {
    return { ok: false, message: `credential expired ${new Date(cred.expiresAt).toISOString().slice(0, 10)}.` };
  }
  let res: Response;
  try {
    res = await fetchImpl(`${cred.url}/api/repro/blocking`, { headers: authHeaders(cred) });
  } catch (e) {
    return { ok: false, message: `could not reach the control plane (${(e as Error).message})` };
  }
  if (!res.ok) return { ok: false, message: `could not fetch blocking derivations (${await safeError(res)})` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, message: "control plane returned a malformed response." };
  }
  return { ok: true, groups: parseGroups(body) };
}

export function registerDiagnose(program: Command): void {
  program
    .command("diagnose")
    .description("Show which derivations are blocking your candidates, and why")
    .option("--json", "output JSON")
    .option("--fail-on-blocking", "exit 1 when at least one blocking derivation is found")
    .action(async (opts: { json?: boolean; failOnBlocking?: boolean }) => {
      const cred = await loadCredentialMaybe();
      const result = await fetchBlockingGroups(cred, fetch);
      if (!result.ok) {
        process.stderr.write(`${pc.red("error")}: ${result.message}\n`);
        if (cred === null) process.stderr.write(`\nTry:\n  ${pc.cyan("vega login")}\n`);
        process.exitCode = EXIT_AUTH_OR_TRANSPORT_ERROR;
        return;
      }

      const { groups } = result;
      if (opts.json) {
        jsonEvent({ groups });
        process.exitCode = decideExit(groups, Boolean(opts.failOnBlocking));
        return;
      }

      if (groups.length === 0) {
        info("Nothing is blocking your candidates right now.");
        process.exitCode = EXIT_OK;
        return;
      }

      info(star(`${groups.length} derivation${groups.length === 1 ? "" : "s"} blocking your candidates`));
      for (const g of groups) {
        info("");
        for (const line of formatGroup(g)) info(line);
      }
      const code = decideExit(groups, Boolean(opts.failOnBlocking));
      if (code !== EXIT_OK) warn("blocking derivations present; exiting non-zero for --fail-on-blocking");
      process.exitCode = code;
    });
}
