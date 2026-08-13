import type { Command } from "commander";
import pc from "picocolors";
import { runChecks, type Check } from "./doctor.js";
import { loadCredentialMaybe, DEFAULT_CONTROL_PLANE } from "../context.js";
import { star, info } from "../ui.js";
import { VERSION, AGENT_REPO } from "../version.js";
import { REPRO_STATUSES } from "../mcp/tools.js";

/** The verdicts the control plane answers with. One list, shared, because the
 * copy this replaced named a verdict the server never sends ("reproduced") and
 * left out the promoted one ("reproducible"), so the report silently dropped
 * the verdict most worth reporting. */
const VERDICTS = new Set<string>(REPRO_STATUSES);

/**
 * Report a problem, with the context that makes a report answerable.
 *
 * The whole report is printed first and nothing is sent from here. The command
 * ends at a GitHub issue URL, which the reader opens, reads and edits before
 * submitting anything. That is the consent step, and it is also why this can
 * afford to gather more than a web page can: the reader sees every byte.
 *
 * What it never gathers, whatever the flags: the credential, the contents of any
 * config file, the environment, or logs. A journal from a machine that builds
 * other people's code can carry a presigned URL with its signature, a
 * control-plane response body or a fragment of a token, and a public tracker is
 * scraped continuously. One leak there costs a credential rotation and an
 * incident, against saving the operator a single email. When a log is genuinely
 * needed, the operator asks for it and a person reads it before it moves.
 */

const ISSUE_URL = `https://github.com/${AGENT_REPO}/issues/new`;

/** A store-path hash, the only shape worth asking the control plane about. */
const STORE_HASH = /^[0-9a-df-np-sv-z]{32}$/;

/** The hash out of a store path, or the hash itself, or null. */
export function hashOf(input: string): string | null {
  const trimmed = input.trim();
  const base = trimmed.startsWith("/") ? (trimmed.split("/").pop() ?? "") : trimmed;
  const candidate = base.slice(0, 32);
  return STORE_HASH.test(candidate) ? candidate : null;
}

/**
 * The report body.
 *
 * Pure, so what gets sent is testable without running any of the checks, and so
 * the rule about what is never included is enforced in one readable place.
 */
export function composeReport(input: {
  checks: readonly Check[];
  version: string;
  platform: string;
  controlPlane: string;
  auth: "enrolled" | "expired" | "none";
  hash?: string | undefined;
  verdict?: string | undefined;
  error?: string | undefined;
  at: string;
}): string {
  const lines = [
    "What went wrong:",
    "",
    "",
    "What I expected instead:",
    "",
    "",
    "---",
    `vega ${input.version} on ${input.platform}`,
    `control plane: ${input.controlPlane}`,
    // The state, never the login. Filing the issue reveals who they are anyway,
    // and it should be their choice rather than something this pasted in.
    `credential: ${input.auth}`,
    `at: ${input.at}`,
  ];
  if (input.hash !== undefined) {
    lines.push(`output: ${input.hash}${input.verdict !== undefined ? ` (${input.verdict})` : ""}`);
  }
  lines.push("", "checks:");
  for (const c of input.checks) {
    // The auth check spells out "enrolled as <login>" for the human running
    // doctor, which is right there and wrong here: this line goes into a public
    // tracker, and the enrolled account is not always the account doing the
    // filing (a machine enrolled as an org or a bot). The state is what makes a
    // report answerable; the identity is the reader's to give.
    const detail = c.name === "auth" ? input.auth : c.detail;
    lines.push(`  ${c.level.padEnd(4)} ${c.name}: ${detail}`);
  }
  if (input.error !== undefined && input.error.trim() !== "") {
    lines.push("", "error text (pasted by hand):", "```", input.error.trim(), "```");
  }
  lines.push("", "Security problems: do not file here. Mail security@adastracomputing.com.");
  return lines.join("\n");
}

export function issueUrl(title: string, body: string): string {
  return `${ISSUE_URL}?labels=user-report&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

export function registerReport(program: Command): void {
  program
    .command("report")
    .description("Compose a problem report and open a prefilled GitHub issue")
    .option("--hash <store-path>", "an output this is about; its public verdict is included")
    .option("--error <text>", "error text to include, quoted verbatim")
    .action(async (opts: { hash?: string; error?: string }) => {
      const checks = await runChecks();
      const cred = await loadCredentialMaybe();
      const controlPlane = cred?.url ?? DEFAULT_CONTROL_PLANE;
      const auth: "enrolled" | "expired" | "none" = !cred
        ? "none"
        : cred.expiresAt && cred.expiresAt < Date.now()
          ? "expired"
          : "enrolled";

      let hash: string | undefined;
      let verdict: string | undefined;
      if (opts.hash !== undefined) {
        const h = hashOf(opts.hash);
        if (h === null) {
          info(pc.red(`not a store path or hash: ${opts.hash}`));
          process.exitCode = 1;
          return;
        }
        hash = h;
        // The public verdict, which is what the reader would see on the status
        // page anyway. A failure here is not worth stopping for.
        try {
          const res = await fetch(`${controlPlane}/api/status/${h}`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            // Only a verdict this CLI knows. The control plane is named by the
            // stored credential, so a tampered file or a hostile server could
            // otherwise put newlines or terminal escapes into a string that is
            // printed here and pasted into a report.
            const v = ((await res.json()) as { verdict?: unknown }).verdict;
            verdict = typeof v === "string" && VERDICTS.has(v) ? v : undefined;
          }
        } catch {
          /* offline, or the control plane is the thing being reported */
        }
      }

      const body = composeReport({
        checks,
        version: VERSION,
        platform: `${process.platform}-${process.arch}`,
        controlPlane,
        auth,
        hash,
        verdict,
        ...(opts.error !== undefined ? { error: opts.error } : {}),
        at: new Date().toISOString(),
      });

      info(star("Vega report"));
      info("");
      for (const line of body.split("\n")) info(`  ${pc.gray(line)}`);
      info("");
      info(`  ${pc.cyan(issueUrl(hash !== undefined ? `Output ${hash}` : "", body))}`);
      info("");
      info(pc.gray("  This opens a GitHub issue prefilled with the report above."));
      info(pc.gray("  Nothing is sent until you submit it on github.com."));
    });
}
