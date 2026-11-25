import type { Command } from "commander";
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import pc from "picocolors";
import { controlPlaneFor, safeError } from "../context.js";
import { githubDeviceToken } from "../github-auth.js";
import { fetchUncompressed } from "../../src/http/no-compression.js";
import { success, info, fail, confirm, isTTY } from "../ui.js";

export interface BuilderDeps {
  url: string;
  /** A GitHub user token, used once and never stored. */
  token(): Promise<string>;
  fetch: typeof fetch;
}

const LABEL = /^[A-Za-z0-9._-]{1,64}$/;

async function call(d: BuilderDeps, method: string, path: string, body?: unknown): Promise<Response> {
  const token = await d.token();
  const res = await d.fetch(`${d.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`the control plane refused the request${await safeError(res)}`);
  return res;
}

/**
 * Enrol a self-hosted builder (spec 0009). What the heartbeat sends is stated,
 * and agreed, before there is a GitHub sign-in or a request. The credential is
 * written to a file only its owner can read, never printed, and an existing
 * file is never overwritten.
 */
export async function runBuilderEnroll(
  d: BuilderDeps,
  label: string,
  o: { out: string; yes: boolean; ask(question: string): Promise<boolean>; say(line: string): void },
): Promise<"enrolled" | "declined"> {
  if (!LABEL.test(label)) throw new Error("the label must be 1 to 64 letters, digits, dots, dashes or underscores");
  o.say(`Vega records the builder "${label}" under your GitHub account. Started with the`);
  o.say("credential, it reports to Vega every minute while its runner is up: its version and");
  o.say("that it runs in a container. Vega keeps no IP address or location for it.");
  o.say(`Terms: ${d.url}/privacy#builders`);
  if (!o.yes && !(await o.ask("Continue?"))) return "declined";
  // The file is claimed before the request: enrolling replaces any earlier
  // credential for this label, so one that could not then be saved would leave
  // the builder with none that works.
  let fd: number;
  try {
    fd = openSync(o.out, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${o.out} already exists; nothing was sent. Move it or pass --out, then enrol again`);
    }
    throw e;
  }
  try {
    const res = await call(d, "POST", "/api/builder/enroll", { label });
    const body = (await res.json()) as { credential: string };
    writeSync(fd, `${body.credential}\n`);
    closeSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(o.out, { force: true });
    throw e;
  }
  return "enrolled";
}

export async function builderList(d: BuilderDeps): Promise<{ label: string; enrolledAt: number; expiresAt: number }[]> {
  return ((await (await call(d, "GET", "/api/builder")).json()) as { builders: { label: string; enrolledAt: number; expiresAt: number }[] }).builders;
}

export async function builderRemove(d: BuilderDeps, label: string): Promise<boolean> {
  return ((await (await call(d, "DELETE", "/api/builder/enroll", { label })).json()) as { removed: boolean }).removed;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

export function registerBuilder(program: Command): void {
  const builder = program
    .command("builder")
    .description("Your self-hosted builders: enrol one so Vega can tell you when it stops")
    .addHelpText("after", "\nEach command signs in with GitHub once; the GitHub token is used for that request and never stored.\n");

  const deps = (opts: { url?: string }, retry: string): BuilderDeps => ({
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

  builder
    .command("enroll <label>")
    .description("Enrol a builder and write its credential to a file")
    .option("--out <file>", "where to write the credential (default: ./vega-builder-<label>.credential)")
    .option("--url <url>", "Vega control plane URL (default: prod, or $VEGA_URL)")
    .option("-y, --yes", "Agree to the terms without the prompt")
    .action((label: string, opts: { out?: string; url?: string; yes?: boolean }) =>
      run(async () => {
        const out = opts.out ?? `vega-builder-${label}.credential`;
        const r = await runBuilderEnroll(deps(opts, `vega builder enroll ${label}`), label, { out, yes: opts.yes === true, ask: confirm, say: info });
        if (r === "declined") fail("aborted (nothing sent).", isTTY ? undefined : [`vega builder enroll ${label} --yes`]);
        success(`Builder ${pc.bold(label)} is enrolled. Its credential is in ${pc.bold(out)}, readable only by you.`);
        info(`  Mount it into the builder read-only and set ${pc.cyan("VEGA_BUILDER_CREDENTIAL_FILE")} to its path.`);
      }),
    );

  builder
    .command("list")
    .description("List your enrolled builders")
    .option("--url <url>", "Vega control plane URL (default: prod, or $VEGA_URL)")
    .action((opts: { url?: string }) =>
      run(async () => {
        const rows = await builderList(deps(opts, "vega builder list"));
        if (rows.length === 0) {
          info(`No builder is enrolled. Enrol one with ${pc.cyan("vega builder enroll <label>")}.`);
          return;
        }
        const w = Math.max(5, ...rows.map((r) => r.label.length));
        info(pc.gray(`${"LABEL".padEnd(w)}  ENROLLED    EXPIRES`));
        for (const r of rows) info(`${r.label.padEnd(w)}  ${day(r.enrolledAt)}  ${day(r.expiresAt)}`);
      }),
    );

  builder
    .command("remove <label>")
    .description("Remove a builder; its credential stops working at once")
    .option("--url <url>", "Vega control plane URL (default: prod, or $VEGA_URL)")
    .action((label: string, opts: { url?: string }) =>
      run(async () => {
        if (await builderRemove(deps(opts, `vega builder remove ${label}`), label)) success(`Builder ${pc.bold(label)} is removed.`);
        else info(`No builder named ${pc.bold(label)} is enrolled.`);
      }),
    );
}
