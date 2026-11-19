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
  const address = raw.trim();
  if (!ADDRESS.test(address) || address.length > 254) throw new Error(`${JSON.stringify(raw)} is not an email address`);
  await call(d, "POST", { address });
}

export async function contactShow(d: ContactDeps): Promise<{ state: string; address?: string | null }> {
  return (await (await call(d, "GET")).json()) as { state: string; address?: string | null };
}

export async function contactRemove(d: ContactDeps): Promise<void> {
  await call(d, "DELETE");
}

export function registerWorker(program: Command): void {
  const worker = program.command("worker").description("Manage your reproduction workers");
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
        // Stated before anything is sent: the request itself stores the address.
        info(`Vega stores ${pc.bold(address.trim())} encrypted. It keeps it for up to 24 hours to send one`);
        info("confirmation message, and after that only if you confirm, to email you when one of");
        info(`your reproduction workers stops or reports again. Terms: ${pc.cyan(`${d.url}/privacy#worker-alerts`)}`);
        if (!opts.yes && !(await confirm("Continue?"))) {
          fail("aborted (no address sent).", isTTY ? undefined : [`vega worker contact set ${address} --yes`]);
        }
        await contactSet(d, address);
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
