import type { Command } from "commander";
import pc from "picocolors";
import {
  requestDeviceCode,
  pollAccessToken,
  VEGA_GITHUB_CLIENT_ID,
} from "../../src/agent/device-flow.js";
import { controlPlaneFor, saveCredential, credentialPath, safeError, saveR2Grant, r2GrantPath } from "../context.js";
import { success, info, keyValues, fail } from "../ui.js";
import { fetchUncompressed } from "../../src/http/no-compression.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("Enroll this machine with the GitHub device flow")
    .option("--url <url>", "Vega control plane URL (default: prod, or $VEGA_URL)")
    .option("--control-plane <url>", "alias for --url")
    .addHelpText(
      "after",
      "\nThe GitHub token is used once and never stored; only the Vega credential is kept.\n",
    )
    .action(async (opts: { url?: string; controlPlane?: string }) => {
      const url = controlPlaneFor(opts.url || opts.controlPlane);
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

      const res = await fetchUncompressed(`${url}/api/owner/enroll`, {
        method: "POST",
        headers: { authorization: `Bearer ${ghToken}` },
      });
      if (!res.ok) fail(`enrollment failed (${await safeError(res)})`);
      const body = (await res.json()) as {
        credential: string;
        login: string;
        userId: string;
        expiresAt: number;
        r2Grant?: { bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string };
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

      // A direct-R2 tenant grant (spec 0006), present only for an account an
      // operator specifically granted one to, and only on the one `vega login`
      // that happens to run after it was created: the control plane erases it
      // from its own storage the instant this response leaves it, so this is
      // the only time it will ever be shown.
      if (body.r2Grant !== undefined) {
        const revealedAt = Date.now();
        await saveR2Grant({ ...body.r2Grant, url, revealedAt });
        info("");
        success("A direct R2 write grant for your tenant was revealed just now.");
        keyValues([
          ["Bucket", body.r2Grant.bucket],
          ["Endpoint", body.r2Grant.endpoint],
          ["Access key id", body.r2Grant.accessKeyId],
          ["Saved to", r2GrantPath()],
        ]);
        info(
          pc.bold(
            "\nThis will not be shown again. Vega has already erased it from its own storage;\n" +
              "the file above is now the only copy. If you lose it, ask an operator to issue a new one.\n",
          ),
        );
      }

      info(`\nNext:\n  ${pc.cyan("vega push .#my-package")}\n  ${pc.cyan("vega view")}`);
    });
}
