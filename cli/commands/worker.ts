import type { Command } from "commander";
import pc from "picocolors";
import { controlPlaneFor, safeError } from "../context.js";
import { githubDeviceToken } from "../github-auth.js";
import { fetchUncompressed } from "../../src/http/no-compression.js";
import { success, info, fail, confirm, isTTY, star, jsonEvent } from "../ui.js";

export interface ContactDeps {
  url: string;
  /** A GitHub user token, used once and never stored. */
  token(): Promise<string>;
  fetch: typeof fetch;
}

const ADDRESS = /^[^\s@]+@[^\s@]+$/;

/** The terms revision this build states, sent as `consent`: the privacy
 * policy's effective date and the version of the alert terms within it (".2"
 * names builders). The control plane refuses an address sent with any other,
 * so a change to the terms needs a release that states them. */
export const WORKER_ALERT_TERMS = "2026-12-19.2";

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
  o.say("your reproduction workers or enrolled builders stops reporting or reports again. It");
  o.say("also sends one message for each version Vega requires, when one of them runs an older");
  o.say("release.");
  o.say(`Terms: ${d.url}/privacy#worker-alerts`);
  if (!o.yes && !(await o.ask("Continue?"))) return "declined";
  await contactSet(d, address);
  return "sent";
}

export interface ContactState {
  state: string;
  address?: string | null;
  /** False for an address agreed under the worker-only terms; absent from an older control plane. */
  builderAlerts?: boolean;
}

export async function contactShow(d: ContactDeps): Promise<ContactState> {
  return (await (await call(d, "GET")).json()) as ContactState;
}

/** What to tell a donor whose address receives no builder alerts, or null. */
export function builderAlertsNote(r: ContactState): string | null {
  return r.state !== "none" && r.builderAlerts === false
    ? "This address was set under earlier terms, so it receives no builder alerts. Run vega worker contact set again to add them."
    : null;
}

export async function contactRemove(d: ContactDeps): Promise<void> {
  await call(d, "DELETE");
}

export type VersionState = "current" | "behind" | "required" | "below-minimum" | "unknown";

export interface MachineRow {
  label: string;
  deployment: string;
  version: string;
  state: VersionState;
  lastSeen: number;
  reporting: boolean;
}

export interface Release {
  latest: string;
  required?: { version: string; from: string; reason: string };
}

export interface WorkerStatus {
  release: Release;
  workers: MachineRow[];
  /** Absent from a control plane that predates builders (spec 0009). */
  builderRelease?: Release;
  builders?: MachineRow[];
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

const UPDATE_GUIDE = "https://docs.vega-cache.dev/contribute#updating-your-worker";
const BUILDER_UPDATE_GUIDE = "https://docs.vega-cache.dev/heavy-builds#updating-your-builder";

/** How the status is painted. Plain by default, so tests and pipes read it as is. */
export interface StatusStyle {
  title(s: string): string;
  header(s: string): string;
  good(s: string): string;
  warn(s: string): string;
  bad(s: string): string;
  dim(s: string): string;
}

const PLAIN: StatusStyle = { title: (s) => s, header: (s) => s, good: (s) => s, warn: (s) => s, bad: (s) => s, dim: (s) => s };

/** "27 Nov 2026" from a YYYY-MM-DD date. */
function day(d: string): string {
  const t = Date.parse(`${d}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(t)) return clean(d);
  const x = new Date(t);
  return `${x.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][x.getUTCMonth()]} ${x.getUTCFullYear()}`;
}

/**
 * The status as lines: a summary, the release, an aligned table, and what to
 * do when a worker needs an update. Padding is applied before colour, so the
 * columns line up whether or not the terminal shows colour.
 */
interface Kind {
  /** "reproduction worker" or "builder", in the summary. */
  noun: string;
  /** "worker" or "builder", in the update line. */
  short: string;
  component: string;
  header: string;
  guide: string;
  /** Vega withholds reproductions from a worker below the minimum; GitHub still gives a builder jobs. */
  belowMinimum: string;
}

const WORKERS: Kind = { noun: "reproduction worker", short: "worker", component: "vega-repro-worker", header: "WORKER", guide: UPDATE_GUIDE, belowMinimum: "below minimum, given no work" };
const BUILDERS: Kind = { noun: "builder", short: "builder", component: "vega-agent", header: "BUILDER", guide: BUILDER_UPDATE_GUIDE, belowMinimum: "below minimum, update now" };

function machineLines(k: Kind, release: Release, machines: MachineRow[], now: number, style: StatusStyle): string[] {
  const req = release.required;
  const inForce = req !== undefined && now >= Date.parse(`${req.from}T00:00:00Z`);
  const rel =
    `Latest ${k.component} ${clean(release.latest)}.` +
    (req === undefined ? "" : ` Vega requires ${clean(req.version)} ${inForce ? "since" : "from"} ${day(req.from)}: ${clean(req.reason)}`);
  if (machines.length === 0) {
    return [style.title(`No ${k.noun} has reported under your account.`), style.dim(rel)];
  }
  const n = machines.length;
  const live = machines.filter((w) => w.reporting).length;
  const head = [k.header, "DEPLOYMENT", "VERSION", "STATE", "STATUS", "LAST REPORT"];
  const rows = machines.map((w) => ({
    cells: [
      clean(w.label),
      clean(w.deployment) || "unstated",
      clean(w.version) || "-",
      w.state === "below-minimum" ? k.belowMinimum : (STATE_TEXT[w.state] ?? clean(String(w.state))),
      w.reporting ? "reporting" : "silent",
      `${span(now - w.lastSeen)} ago`,
    ],
    w,
  }));
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((x) => x.cells[i]!.length)));
  const pad = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(width[i]!)));
  const stateColor = (st: VersionState) =>
    st === "current" ? style.good : st === "behind" || st === "unknown" ? style.warn : style.bad;
  const lines = [
    style.title(`${n} ${k.noun}${n === 1 ? "" : "s"}, ${live} reporting`),
    style.dim(rel),
    "",
    style.header(pad(head).join("  ")),
    ...rows.map(({ cells, w }) => {
      const p = pad(cells);
      p[3] = stateColor(w.state)(p[3]!);
      p[4] = (w.reporting ? style.good : style.warn)(p[4]!);
      p[5] = style.dim(p[5]!);
      return p.join("  ");
    }),
  ];
  const stale = machines.filter((w) => w.state === "behind" || w.state === "required" || w.state === "below-minimum").length;
  if (stale > 0) lines.push("", `${stale} ${k.short}${stale === 1 ? " needs" : "s need"} an update: ${k.guide}`);
  return lines;
}

/** The workers alone, as `vega worker status` prints them. */
export function statusLines(r: WorkerStatus, now: number, style: StatusStyle = PLAIN): string[] {
  return machineLines(WORKERS, r.release, r.workers, now, style);
}

/** Workers, then builders, one section each, leaving out a kind the account
 * has none of. Each section's first line is its title. */
export function fleetSections(r: WorkerStatus, now: number, style: StatusStyle = PLAIN): string[][] {
  const builders = r.builders ?? [];
  if (r.workers.length === 0 && builders.length === 0) {
    return [[style.title("No worker or builder has reported under your account.")]];
  }
  const out: string[][] = [];
  if (r.workers.length > 0) out.push(machineLines(WORKERS, r.release, r.workers, now, style));
  if (builders.length > 0 && r.builderRelease !== undefined) out.push(machineLines(BUILDERS, r.builderRelease, builders, now, style));
  return out;
}

export function fleetLines(r: WorkerStatus, now: number, style: StatusStyle = PLAIN): string[] {
  return fleetSections(r, now, style).flatMap((sec, i) => (i === 0 ? sec : ["", ...sec]));
}

const STYLE: StatusStyle = {
  title: (t) => star(pc.bold(t)),
  header: pc.gray,
  good: pc.green,
  warn: pc.yellow,
  bad: pc.red,
  dim: pc.gray,
};

/** A section's starred title, then its lines indented beneath it. */
function printSection(lines: string[]): void {
  info(lines[0]!);
  for (const line of lines.slice(1)) info(line === "" ? "" : `  ${line}`);
}

/** `vega fleet status`: your workers and your builders together. */
export function registerFleet(program: Command): void {
  const fleet = program.command("fleet").description("Your reproduction workers and self-hosted builders");
  fleet
    .command("status")
    .description("Every worker and builder you run: version, whether it is current, and when each last reported")
    .option("--url <url>", "Vega control plane URL (default: prod, or $VEGA_URL)")
    .option("--json", "output JSON")
    .action(async (opts: { url?: string; json?: boolean }) => {
      try {
        const r = await workerStatus({ url: controlPlaneFor(opts.url), token: () => githubDeviceToken("vega fleet status"), fetch: fetchUncompressed });
        if (opts.json) {
          jsonEvent(r);
          return;
        }
        fleetSections(r, Date.now(), STYLE).forEach((sec, i) => {
          if (i > 0) info("");
          printSection(sec);
        });
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    });
}

export function registerWorker(program: Command): void {
  const worker = program.command("worker").description("Manage your reproduction workers");
  worker
    .command("status")
    .description("Your reproduction workers: version, whether it is current, and when each last reported")
    .option("--url <url>", "Vega control plane URL (default: prod, or $VEGA_URL)")
    .option("--json", "output JSON")
    .action((opts: { url?: string; json?: boolean }) =>
      run(async () => {
        const r = await workerStatus(deps(opts, "vega worker status"));
        if (opts.json) {
          jsonEvent(r);
          return;
        }
        printSection(statusLines(r, Date.now(), STYLE));
      }),
    );

  const contact = worker
    .command("contact")
    .description("Email alerts when one of your reproduction workers or builders stops reporting")
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
        const note = builderAlertsNote(r);
        if (note !== null) info(note);
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
