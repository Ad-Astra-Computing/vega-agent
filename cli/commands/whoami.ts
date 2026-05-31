import type { Command } from "commander";
import pc from "picocolors";
import { requireCredential } from "../context.js";
import { star, info, keyValues, jsonEvent } from "../ui.js";

export function registerWhoami(program: Command): void {
  program
    .command("whoami")
    .description("Show the enrolled identity and namespace")
    .option("--json", "output JSON")
    .action(async (opts: { json?: boolean }) => {
      const cred = await requireCredential();
      if (opts.json) {
        jsonEvent({
          login: cred.login,
          userId: cred.userId,
          namespace: `owner:${cred.userId}`,
          controlPlane: cred.url,
          expiresAt: cred.expiresAt,
        });
        return;
      }
      info(star(`Enrolled as ${pc.bold(cred.login)}`));
      keyValues([
        ["Namespace", `owner:${cred.userId}`],
        ["User id", cred.userId],
        ["Control plane", cred.url],
        ["Expires", new Date(cred.expiresAt).toISOString().slice(0, 10)],
      ]);
    });
}
