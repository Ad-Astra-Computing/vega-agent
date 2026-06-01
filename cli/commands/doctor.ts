import type { Command } from "commander";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pc from "picocolors";
import { loadCredentialMaybe, DEFAULT_CONTROL_PLANE } from "../context.js";
import { star, info } from "../ui.js";
import { VERSION, AGENT_REPO, compareVersions } from "../version.js";

const exec = promisify(execFile);

type Level = "ok" | "warn" | "fail";
interface Check {
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

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose local setup: nix, zstd, auth, connectivity")
    .action(async () => {
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
        connOk = (await fetch(`${url}/nix-cache-info`)).ok;
      } catch {
        connOk = false;
      }
      checks.push(
        connOk
          ? { name: "control plane", level: "ok", detail: url }
          : { name: "control plane", level: "fail", detail: `unreachable: ${url}` },
      );

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

      info(star("Vega doctor"));
      const mark = { ok: pc.green("ok  "), warn: pc.yellow("warn"), fail: pc.red("fail") };
      for (const c of checks) {
        info(`  ${mark[c.level]}  ${c.name.padEnd(14)} ${pc.gray(c.detail)}`);
        if (c.fix) info(`        ${pc.gray("fix:")} ${pc.cyan(c.fix)}`);
      }
      const failed = checks.some((c) => c.level === "fail");
      if (failed) process.exitCode = 1;
    });
}
