import type { Command } from "commander";
import pc from "picocolors";
import { controlPlaneFor, safeError } from "../context.js";
import { githubDeviceToken } from "../github-auth.js";
import { fetchUncompressed } from "../../src/http/no-compression.js";
import { success, info, fail, confirm, isTTY } from "../ui.js";

export interface ContactDeps {
  url: string;
  /** A GitHub user token, used once and never stored. */
  token(): Promise<string>;
  fetch: typeof fetch;
}

const ADDRESS = /^[^\s@]+@[^\s@]+$/;

/** The terms revision this build states, sent as `consent`. It is the privacy
 * policy's effective date for worker alerts; the control plane refuses an
 * address sent with any other, so a policy change needs a release that states
 * the new terms. */
export const WORKER_ALERT_TERMS = "2026-12-19";

function parse(raw: string): string {
  const address = raw.trim();
  if (!ADDRESS.test(address) || address.length > 254) throw new Error(`${JSON.stringify(raw)} is not an email address`);
  return address;
}

async function call(d: ContactDeps, method: string, body?: unknown): Promise<Response> {
  const token = await d.token();
  const res = await d.fetch(`${d.url}/api/worker/contact`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`the control plane refused the request${await safeError(res)}`);
  return res;
}

export async function contactSet(d: ContactDeps, raw: string): Promise<void> {
  await call(d, "POST", { address: parse(raw), consent: WORKER_ALERT_TERMS });
}

/**
 * The order is the point: the terms are shown, then agreed, and only then is
 * there a GitHub sign-in or a request, because the request itself stores the
 * address.
 */
export async function runContactSet(
  d: ContactDeps,
  raw: string,
  o: { yes: boolean; ask(question: string): Promise<boolean>; say(line: string): void },
): Promise<"sent" | "declined"> {
  const address = parse(raw);
  o.say(`Vega stores ${address} encrypted. It keeps it for up to 24 hours to send one`);
  o.say("confirmation message, and after that only if you confirm, to email you when one of");
  o.say("your reproduction workers stops reporting or reports again. It also sends one");
  o.say("message for each version Vega requires, when one of them runs an older release.");
  o.say(`Terms: ${d.url}/privacy#worker-alerts`);
  if (!o.yes && !(await o.ask("Continue?"))) return "declined";
  await contactSet(d, address);
  return "sent";
}

export async function contactShow(d: ContactDeps): Promise<{ state: string; address?: string | null }> {
  return (await (await call(d, "GET")).json()) as { state: string; address?: string | null };
}

export async function contactRemove(d: ContactDeps): Promise<void> {
  await call(d, "DELETE");
}

export type VersionState = "current" | "behind" | "required" | "below-minimum" | "unknown";

export interface WorkerStatus {
  release: { latest: string; required?: { version: string; from: string; reason: string } };
  workers: { label: string; deployment: string; version: string; state: VersionState; lastSeen: number; reporting: boolean }[];
}

/** Your own reproduction workers, as the control plane last heard from them. */
export async function workerStatus(d: ContactDeps): Promise<WorkerStatus> {
  const token = await d.token();
  const res = await d.fetch(`${d.url}/api/worker/status`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`the control plane refused the request${await safeError(res)}`);
  return (await res.json()) as WorkerStatus;
}

/** Labels, versions and reasons are self-reported or server-supplied, so
 * nothing that can drive the terminal or reorder text is printed. */
function clean(v: string): string {
  return v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").slice(0, 120);
}

/** "2 min", "1 h 30 min", "3 d 4 h". */
function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
  const days = Math.floor(h / 24);
  return h % 24 === 0 ? `${days} d` : `${days} d ${h % 24} h`;
}

const STATE_TEXT: Record<VersionState, string> = {
  current: "current",
  behind: "update available",
  required: "update required",
  "below-minimum": "below minimum, given no work",
  unknown: "version not reported",
};

/** The status as lines, colour applied by the caller's terminal check. */
export function statusLines(r: WorkerStatus, now: number, color: (s: string, st: VersionState) => string = (s) => s): string[] {
  const req = r.release.required;
  const inForce = req !== undefined && now >= Date.parse(`${req.from}T00:00:00Z`);
  const head =
    `Latest vega-repro-worker: ${clean(r.release.latest)}.` +
    (req === undefined ? "" : ` Vega requires ${clean(req.version)} ${inForce ? "since" : "from"} ${clean(req.from)}: ${clean(req.reason)}`);
  if (r.workers.length === 0) return [head, "", "No worker has reported under your account."];
  const rows = r.workers.map((w) => [
    clean(w.label),
    clean(w.deployment) || "unstated",
    clean(w.version) || "-",
    STATE_TEXT[w.state] ?? clean(String(w.state)),
    `${w.reporting ? "reporting" : "silent"}, ${span(now - w.lastSeen)} ago`,
    w.state,
  ]);
  const width = (i: number) => Math.max(...rows.map((x) => x[i]!.length));
  const lines = rows.map((x) =>
    [0, 1, 2].map((i) => x[i]!.padEnd(width(i))).join("  ") + "  " + color(x[3]!.padEnd(width(3)), x[5] as VersionState) + "  " + x[4],
  );
  return [head, "", ...lines];
}

export function registerWorker(program: Command): void {
  const worker = program.command("worker").description("Manage your reproduction workers");
  worker
    .command("status")
    .description("Your reproduction workers: version, whether it is current, and when each last reported")
    .option("--url <url>", "Vega control plane URL (default: prod, or $VEGA_URL)")
    .action((opts: { url?: string }) =>
      run(async () => {
        const r = await workerStatus(deps(opts, "vega worker status"));
        const paint = (s: string, st: VersionState) =>
          st === "current" ? pc.green(s) : st === "behind" ? pc.yellow(s) : st === "unknown" ? pc.dim(s) : pc.red(s);
        for (const line of statusLines(r, Date.now(), paint)) info(line);
      }),
    );

  const contact = worker
    .command("contact")
    .description("Email alerts when one of your reproduction workers stops reporting")
    .addHelpText(
      "after",
      "\nEach command signs in with GitHub once; the GitHub token is used for that request and never stored.\n",
    );

  const deps = (opts: { url?: string }, retry: string): ContactDeps => ({
    url: controlPlaneFor(opts.url),
    token: () => githubDeviceToken(retry),
    fetch: fetchUncompressed,
  });
  const run = async (f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  };

  contact
    .command("set <address>")
    .description("Send alerts to this address, once you confirm it")
    .option("--url <url>", "Vega control plane URL (default: prod, or $VEGA_URL)")
    .option("-y, --yes", "Agree to the terms without the prompt")
    .action((address: string, opts: { url?: string; yes?: boolean }) =>
      run(async () => {
        const d = deps(opts, `vega worker contact set ${address}`);
        const r = await runContactSet(d, address, { yes: opts.yes === true, ask: confirm, say: info });
        if (r === "declined") {
          fail("aborted (no address sent).", isTTY ? undefined : [`vega worker contact set ${address} --yes`]);
        }
        success(`Vega sends a confirmation message to ${pc.bold(address.trim())} if it can.`);
        info("  Alerts start once you follow the link in it. The link works for 24 hours.");
      }),
    );

  contact
    .command("show")
    .description("Show the alert address and whether it is confirmed")
    .option("--url <url>", "Vega control plane URL (default: prod, or $VEGA_URL)")
    .action((opts: { url?: string }) =>
      run(async () => {
        const r = await contactShow(deps(opts, "vega worker contact show"));
        if (r.state === "none") info(`No alert address. Add one with ${pc.cyan("vega worker contact set <address>")}.`);
        else if (r.state === "pending") info(`${pc.bold(r.address ?? "The address")} is waiting for you to confirm it.`);
        else success(`Worker alerts go to ${pc.bold(r.address ?? "your confirmed address")}.`);
      }),
    );

  contact
    .command("remove")
    .description("Stop alerts and delete the address")
    .option("--url <url>", "Vega control plane URL (default: prod, or $VEGA_URL)")
    .action((opts: { url?: string }) =>
      run(async () => {
        await contactRemove(deps(opts, "vega worker contact remove"));
        success("Worker alerts are off, and Vega no longer stores the address.");
      }),
    );
}
