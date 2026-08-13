import type { Command } from "commander";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pc from "picocolors";
import { loadCredentialMaybe, DEFAULT_CONTROL_PLANE } from "../context.js";
import { star, info, jsonEvent } from "../ui.js";
import { VERSION, AGENT_REPO, compareVersions } from "../version.js";
import { findSubstituterMismatch, tenantKeyNames } from "../../src/agent/substituter.js";

const exec = promisify(execFile);

export type Level = "ok" | "warn" | "fail";
export interface Check {
  name: string;
  level: Level;
  detail: string;
  fix?: string;
}

async function onPath(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args);
    return stdout.trim().split("\n")[0] ?? "";
  } catch {
    return null;
  }
}

/**
 * Everything the CLI can say about this machine's setup.
 *
 * Extracted so `vega report` composes a report from exactly what `vega doctor`
 * shows, rather than a second copy that drifts. Diagnosing and reporting are
 * different jobs, so they stay different commands, but they must not disagree
 * about the facts.
 */
export async function runChecks(): Promise<Check[]> {
    const checks: Check[] = [];

    const nix = await onPath("nix", ["--version"]);
    checks.push(
      nix
        ? { name: "nix", level: "ok", detail: nix }
        : { name: "nix", level: "fail", detail: "not found", fix: "Install Nix: https://nixos.org/download" },
    );

    const zstd = await onPath("zstd", ["--version"]);
    checks.push(
      zstd
        ? { name: "zstd", level: "ok", detail: "available" }
        : {
            name: "zstd",
            level: "warn",
            detail: "not found (needed by `vega push`)",
            fix: "nix profile install nixpkgs#zstd, or run push inside `nix shell nixpkgs#zstd`",
          },
    );

    const cred = await loadCredentialMaybe();
    const expired = cred ? Boolean(cred.expiresAt && cred.expiresAt < Date.now()) : false;
    checks.push(
      !cred
        ? { name: "auth", level: "warn", detail: "not enrolled", fix: "vega login" }
        : expired
          ? { name: "auth", level: "warn", detail: "credential expired", fix: "vega login" }
          : { name: "auth", level: "ok", detail: `enrolled as ${cred.login}` },
    );

    const url = cred?.url ?? DEFAULT_CONTROL_PLANE;
    let connOk = false;
    try {
      // Bounded like the other two probes. Unbounded, this hangs for undici's
    // default against a blackholed host, which is precisely the case where
    // somebody is trying to run `vega report` about that host.
    connOk = (await fetch(`${url}/nix-cache-info`, { signal: AbortSignal.timeout(5000) })).ok;
    } catch {
      connOk = false;
    }
    checks.push(
      connOk
        ? { name: "control plane", level: "ok", detail: url }
        : { name: "control plane", level: "fail", detail: `unreachable: ${url}` },
    );

    // A tenant key trusted while no substituter can serve its paths. The bare
    // control-plane URL answers /nix-cache-info with 200 (it is the shared-tier
    // cache), so Nix accepts it and then silently misses every tenant path: a
    // deployment ran that way for ten days, rebuilding its full closure on
    // every CI run. Nothing at build time distinguishes it from a cold cache,
    // so doctor is the place that can.
    if (nix !== null) {
      const subs = await onPath("nix", ["config", "show", "substituters"]);
      const keys = await onPath("nix", ["config", "show", "trusted-public-keys"]);
      if (subs !== null && keys !== null) {
        const mismatch = findSubstituterMismatch(
          subs.split(/\s+/).filter(Boolean),
          keys.split(/\s+/).filter(Boolean),
          url,
        );
        checks.push(
          mismatch === null
            ? {
                name: "substituter",
                level: "ok",
                // Claim only what was checked: "agree" when tenant keys exist
                // and are servable, otherwise just that none are configured.
                detail:
                  tenantKeyNames(keys.split(/\s+/).filter(Boolean)).length > 0
                    ? "tenant keys and substituters agree"
                    : "no tenant keys in the nix config",
              }
            : {
                name: "substituter",
                level: "warn",
                detail: mismatch,
                fix: "add the extra-substituters line the agent prints after a push (the /tenant/<owner>/<repo> URL)",
              },
        );
      }
    }

    // Explicit, on-demand staleness check (never a startup phone-home): compare
    // the running version to the latest published agent release. A network
    // hiccup or no-releases-yet is informational, not a failure.
    try {
      const res = await fetch(`https://api.github.com/repos/${AGENT_REPO}/releases/latest`, {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(4000),
      });
      if (res.status === 404) {
        checks.push({ name: "version", level: "ok", detail: `${VERSION} (no published releases yet)` });
      } else if (res.ok) {
        const tag = ((await res.json()) as { tag_name?: unknown }).tag_name;
        if (typeof tag === "string" && compareVersions(tag, VERSION) > 0) {
          checks.push({
            name: "version",
            level: "warn",
            detail: `${VERSION} (latest ${tag})`,
            fix: `nix flake update vega-agent  (input), or  nix run --refresh github:${AGENT_REPO}#vega`,
          });
        } else {
          checks.push({ name: "version", level: "ok", detail: `${VERSION} (current)` });
        }
      } else {
        checks.push({ name: "version", level: "ok", detail: `${VERSION} (check unavailable)` });
      }
    } catch {
      checks.push({ name: "version", level: "ok", detail: `${VERSION} (offline)` });
    }

  return checks;
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose local setup: nix, zstd, auth, connectivity")
    .option("--json", "output JSON")
    .action(async (opts: { json?: boolean }) => {
      const checks = await runChecks();

      const failed = checks.some((c) => c.level === "fail");
      if (opts.json) {
        jsonEvent({ ok: !failed, checks });
        if (failed) process.exitCode = 1;
        return;
      }

      info(star("Vega doctor"));
      const mark = { ok: pc.green("ok  "), warn: pc.yellow("warn"), fail: pc.red("fail") };
      for (const c of checks) {
        info(`  ${mark[c.level]}  ${c.name.padEnd(14)} ${pc.gray(c.detail)}`);
        if (c.fix) info(`        ${pc.gray("fix:")} ${pc.cyan(c.fix)}`);
      }
      if (failed) process.exitCode = 1;
    });
}
