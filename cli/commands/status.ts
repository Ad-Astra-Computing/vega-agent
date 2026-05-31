import type { Command } from "commander";
import pc from "picocolors";
import { loadCredentialMaybe, DEFAULT_CONTROL_PLANE } from "../context.js";
import { star, info, keyValues, jsonEvent } from "../ui.js";

async function reachable(url: string): Promise<{ ok: boolean; ms: number }> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${url}/nix-cache-info`, { method: "GET" });
    return { ok: res.ok, ms: Date.now() - t0 };
  } catch {
    return { ok: false, ms: Date.now() - t0 };
  }
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show auth, cache, and connectivity state")
    .option("--json", "output JSON")
    .action(async (opts: { json?: boolean }) => {
      const cred = await loadCredentialMaybe();
      const url = cred?.url ?? DEFAULT_CONTROL_PLANE;
      const expired = cred ? Boolean(cred.expiresAt && cred.expiresAt < Date.now()) : false;
      const conn = await reachable(url);

      if (opts.json) {
        jsonEvent({
          enrolled: Boolean(cred) && !expired,
          login: cred?.login ?? null,
          namespace: cred ? `owner:${cred.userId}` : null,
          controlPlane: url,
          reachable: conn.ok,
          latencyMs: conn.ms,
        });
        return;
      }

      info(star("Vega status"));
      const identity = !cred
        ? pc.yellow("not enrolled")
        : expired
          ? pc.yellow(`expired (was ${cred.login})`)
          : `${pc.bold(cred.login)}  (${pc.gray(`owner:${cred.userId}`)})`;
      keyValues([
        ["Identity", identity],
        ["Control plane", url],
        ["Reachable", conn.ok ? pc.green(`yes (${conn.ms}ms)`) : pc.red(`no (${conn.ms}ms)`)],
      ]);
      if (!cred) info(`\n  Run ${pc.cyan("vega login")} to enroll.`);
      else if (expired) info(`\n  Run ${pc.cyan("vega login")} to renew.`);
    });
}
