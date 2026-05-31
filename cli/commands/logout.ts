import type { Command } from "commander";
import { clearCredential } from "../context.js";
import { success, info } from "../ui.js";

export function registerLogout(program: Command): void {
  program
    .command("logout")
    .description("Remove this machine's stored Vega credential")
    .action(async () => {
      const removed = await clearCredential();
      if (removed) success("Logged out; credential removed.");
      else info("No credential to remove.");
    });
}
