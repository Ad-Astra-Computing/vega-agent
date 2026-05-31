import type { Command } from "commander";
import pc from "picocolors";
import {
  requestDeviceCode,
  pollAccessToken,
  VEGA_GITHUB_CLIENT_ID,
} from "../../src/agent/device-flow.js";
import { controlPlaneFor, saveCredential, credentialPath, safeError } from "../context.js";
import { success, info, keyValues, fail } from "../ui.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("Enroll this machine with the GitHub device flow")
    .option("--control-plane <url>", "Vega control plane URL (default: prod, or $VEGA_URL)")
    .addHelpText(
      "after",
      "\nThe GitHub token is used once and never stored; only the Vega credential is kept.\n",
    )
    .action(async (opts: { controlPlane?: string }) => {
      const url = controlPlaneFor(opts.controlPlane);
      const dc = await requestDeviceCode(VEGA_GITHUB_CLIENT_ID);
      info(`\n  Open ${pc.cyan(dc.verificationUri)} and enter code:  ${pc.bold(dc.userCode)}\n`);
      info("  Waiting for authorization...");

      let interval = dc.interval;
      const deadline = Date.now() + dc.expiresIn * 1000;
      let ghToken: string | undefined;
      while (Date.now() < deadline) {
        await sleep(interval * 1000);
        const r = await pollAccessToken(VEGA_GITHUB_CLIENT_ID, dc.deviceCode);
        if (r.status === "token") {
          ghToken = r.accessToken;
          break;
        }
        if (r.status === "slow_down") interval = r.interval;
        else if (r.status === "error") fail(`authorization failed: ${r.error}`);
      }
      if (ghToken === undefined) fail("device code expired before authorization.", ["vega login"]);

      const res = await fetch(`${url}/api/owner/enroll`, {
        method: "POST",
        headers: { authorization: `Bearer ${ghToken}` },
      });
      if (!res.ok) fail(`enrollment failed (${await safeError(res)})`);
      const body = (await res.json()) as {
        credential: string;
        login: string;
        userId: string;
        expiresAt: number;
      };
      await saveCredential({
        credential: body.credential,
        login: body.login,
        userId: body.userId,
        expiresAt: body.expiresAt,
        url,
      });

      info("");
      success(`Enrolled as ${pc.bold(body.login)}`);
      keyValues([
        ["Namespace", `owner:${body.userId}`],
        ["Control plane", url],
        ["Credential", credentialPath()],
        ["Expires", new Date(body.expiresAt).toISOString().slice(0, 10)],
      ]);
      info(`\nNext:\n  ${pc.cyan("vega push .#my-package")}\n  ${pc.cyan("vega view")}`);
    });
}
