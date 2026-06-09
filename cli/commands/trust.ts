import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { requireCredential, authHeaders, safeError, type StoredCredential } from "../context.js";
import { star, info, success, fail, jsonEvent, isTTY } from "../ui.js";

type Scope =
  | { kind: "all" }
  | { kind: "package"; name: string }
  | { kind: "flake"; name: string }
  | { kind: "org"; name: string };

interface ScopeOpts {
  package?: string;
  flake?: string;
  org?: string;
}

/** Resolve a GitHub login to its immutable numeric id; pass a numeric id through. */
async function resolveBuilder(subject: string): Promise<string> {
  if (/^[0-9]+$/.test(subject)) return subject;
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(subject)}`, {
    headers: { "user-agent": "vega-cli", accept: "application/vnd.github+json" },
  });
  if (!res.ok) fail(`could not resolve GitHub user '${subject}': ${res.status}`);
  const { id } = (await res.json()) as { id?: number };
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    fail(`GitHub user '${subject}' has no valid id`);
  }
  return String(id);
}

function scopeOf(opts: ScopeOpts): Scope {
  const given = [opts.package && "--package", opts.flake && "--flake", opts.org && "--org"].filter(Boolean);
  if (given.length > 1) fail(`use at most one of ${given.join(", ")}`);
  if (opts.package) return { kind: "package", name: opts.package };
  if (opts.flake !== undefined) {
    const name = opts.flake.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/.test(name)) fail("--flake must be a GitHub owner/repo");
    return { kind: "flake", name };
  }
  if (opts.org !== undefined) {
    const name = opts.org.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(name)) fail("--org must be a GitHub owner");
    return { kind: "org", name };
  }
  return { kind: "all" };
}
function scopeLabel(s: Scope): string {
  switch (s.kind) {
    case "all":
      return "all builds";
    case "package":
      return `the ${pc.bold(s.name)} package`;
    case "flake":
      return `builds with verified provenance from the ${pc.bold(s.name)} flake`;
    case "org":
      return `builds with verified provenance from any ${pc.bold(s.name)} repo`;
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!isTTY) return false; // never auto-confirm a security action in non-interactive use
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return a === "y" || a === "yes";
  } finally {
    rl.close();
  }
}

async function postTrust(
  cred: StoredCredential,
  path: string,
  builder: string,
  scope: Scope,
  acceptUnreproducible = false,
): Promise<void> {
  const res = await fetch(`${cred.url}${path}`, {
    method: "POST",
    headers: authHeaders(cred),
    body: JSON.stringify(acceptUnreproducible ? { builder, scope, acceptUnreproducible } : { builder, scope }),
  });
  if (!res.ok) fail(`${path} failed (${await safeError(res)})`);
}

export function registerTrust(program: Command): void {
  const trust = program.command("trust").description("Manage who your view will substitute builds from");

  trust
    .command("add <subject>")
    .description("Trust builds from a GitHub user or numeric id")
    .option("--package <name>", "Restrict to one package (default: all their builds)")
    .option("--flake <owner/repo>", "Restrict to builds with verified provenance from this flake")
    .option("--org <owner>", "Restrict to builds with verified provenance from any repo under this org")
    .option("--accept-unreproducible", "Also accept this builder's builds Vega's reproducer diverged from (risky)")
    .option("-y, --yes", "Skip the confirmation prompt")
    .addHelpText(
      "after",
      "\n--flake/--org match only builds with a verified github-hosted CI attestation\n" +
        "from that flake/org; a build without one is not covered by these scopes.\n" +
        "\nBy default Vega withholds a binding its own reproducer diverged from (got a\n" +
        "different hash than the builder). --accept-unreproducible opts THIS edge into\n" +
        "serving those anyway, at your own risk (e.g. a known-nondeterministic build).\n",
    )
    .action(async (subject: string, opts: ScopeOpts & { yes?: boolean; acceptUnreproducible?: boolean }) => {
      const cred = await requireCredential();
      const builder = await resolveBuilder(subject);
      const scope = scopeOf(opts);
      // A precise security decision, stated plainly, not a scary modal.
      info(star("You are about to trust builds from:"));
      info(`  Builder:  ${pc.bold(subject)} (id ${builder})`);
      info(`  Scope:    ${scopeLabel(scope)}`);
      info(`  Effect:   matching builds may be substituted into your Vega view`);
      if (opts.acceptUnreproducible) {
        info(`  ${pc.yellow("Risk:")}     also accepts builds Vega's reproducer DIVERGED from (not independently verified)`);
      }
      info(pc.gray("\nThis does NOT give them access to your namespace; it lets their matching"));
      info(pc.gray("build outputs satisfy your Nix substitutions within the scope above.\n"));
      if (!opts.yes && !(await confirm("Continue?"))) {
        fail("aborted (no trust edge created).", isTTY ? undefined : ["vega trust add <subject> --yes"]);
      }
      await postTrust(cred, "/api/trust", builder, scope, opts.acceptUnreproducible);
      success(`You now trust builds from ${pc.bold(subject)} for ${scopeLabel(scope)}.`);
    });

  trust
    .command("remove <subject>")
    .description("Revoke a trust edge")
    .option("--package <name>", "The scoped package (omit for the all-builds edge)")
    .option("--flake <owner/repo>", "The scoped flake")
    .option("--org <owner>", "The scoped org")
    .action(async (subject: string, opts: ScopeOpts) => {
      const cred = await requireCredential();
      const builder = await resolveBuilder(subject);
      const scope = scopeOf(opts);
      await postTrust(cred, "/api/trust/revoke", builder, scope);
      success(`Removed trust for ${pc.bold(subject)} (${scopeLabel(scope)}).`);
    });

  trust
    .command("list")
    .description("Show your trust edges")
    .option("--json", "output JSON")
    .action(async (opts: { json?: boolean }) => {
      const cred = await requireCredential();
      const res = await fetch(`${cred.url}/api/trust`, { headers: authHeaders(cred) });
      if (!res.ok) fail(`list failed (${await safeError(res)})`);
      const { edges } = (await res.json()) as {
        edges: { builder: string; scope: Scope; revokedAt?: number }[];
      };
      if (opts.json) {
        jsonEvent({ edges });
        return;
      }
      const active = edges.filter((e) => !e.revokedAt);
      if (active.length === 0) {
        info("No trust edges. Add one with `vega trust add <github-user>`.");
        return;
      }
      info(star(`${active.length} trust edge(s):`));
      for (const e of active) info(`  builder ${pc.bold(e.builder)}: ${scopeLabel(e.scope)}`);
    });
}
