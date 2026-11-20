import type { Command } from "commander";
import pc from "picocolors";
import { githubDeviceToken } from "../github-auth.js";
import { controlPlaneFor, saveCredential, credentialPath, safeError, saveR2Grant, r2GrantPath } from "../context.js";
import { success, info, keyValues, fail, warn } from "../ui.js";
import { fetchUncompressed } from "../../src/http/no-compression.js";

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
      const ghToken = await githubDeviceToken("vega login");

      const res = await fetchUncompressed(`${url}/api/owner/enroll`, {
        method: "POST",
        // The control plane only reveals a pending direct-R2 grant (spec 0006)
        // to a client that declares it can actually display and save one: an
        // older build has no code for it and would silently discard the one
        // reveal a server that only checked "is a grant pending" would burn.
        headers: { authorization: `Bearer ${ghToken}`, "x-vega-capabilities": "r2-grant" },
      });
      if (!res.ok) fail(`enrollment failed (${await safeError(res)})`);
      const body = (await res.json()) as {
        credential: string;
        login: string;
        userId: string;
        expiresAt: number;
        r2Grant?: { bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string };
      };
      // The grant, if present, is saved BEFORE the owner credential on
      // purpose. The control plane has already erased its own copy by the
      // time this response arrives, so it cannot be fetched again; the
      // credential can, with a second `vega login`. If the process dies
      // between the two saves, it dies having kept the one thing that
      // cannot be recovered.
      let revealedGrant = false;
      if (
        body.r2Grant !== undefined &&
        typeof body.r2Grant.bucket === "string" &&
        typeof body.r2Grant.endpoint === "string" &&
        typeof body.r2Grant.accessKeyId === "string" &&
        typeof body.r2Grant.secretAccessKey === "string"
      ) {
        const grant = body.r2Grant;
        try {
          await saveR2Grant({ ...grant, url, revealedAt: Date.now() });
          revealedGrant = true;
        } catch (e) {
          // This is the only chance: the server has already forgotten its
          // copy. Printing it once to stderr, loudly, beats losing it, even
          // though it means it may now sit in a terminal scrollback.
          warn(`could not save the direct-R2 grant to disk (${e instanceof Error ? e.message : String(e)}).`);
          warn("printing it once instead, since the control plane will not show it again:");
          process.stderr.write(`${JSON.stringify(grant, null, 2)}\n`);
        }
      }

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

      if (revealedGrant && body.r2Grant !== undefined) {
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
