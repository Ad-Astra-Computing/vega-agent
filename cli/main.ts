#!/usr/bin/env node
// `vega` - the command line for the Vega verifiable binary cache.
//
// One entrypoint, real per-command help, output that adapts to TTY / CI / --json.
// Command logic lives in ./commands/*; rendering in ./ui.ts. The build AGENT that
// runs in CI is separate (../agent/main.ts); this is the human-facing tool.

import { Command } from "commander";
import { brandIntro } from "./ui.js";
import { registerLogin } from "./commands/login.js";
import { registerLogout } from "./commands/logout.js";
import { registerWhoami } from "./commands/whoami.js";
import { registerView } from "./commands/view.js";
import { registerTrust } from "./commands/trust.js";
import { registerPush } from "./commands/push.js";
import { registerStatus } from "./commands/status.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerVerify } from "./commands/verify.js";

const program = new Command();

program
  .name("vega")
  .description(
    "Verifiable Nix binary cache: reproducible builds, a public transparency\n" +
      "log, and scoped social trust.",
  )
  .version("0.1.0", "-v, --version")
  .showHelpAfterError("(run `vega <command> --help` for details)")
  .configureHelp({ sortSubcommands: true })
  .addHelpText(
    "after",
    "\nExamples:\n" +
      "  vega login\n" +
      "  vega push .#my-package\n" +
      "  vega verify /nix/store/<hash>-hello-2.12.1\n" +
      "  vega view --format nix-conf\n" +
      "  vega trust add github:alice --scope hello\n",
  );

registerLogin(program);
registerLogout(program);
registerWhoami(program);
registerView(program);
registerTrust(program);
registerPush(program);
registerStatus(program);
registerDoctor(program);
registerVerify(program);

async function run(): Promise<void> {
  // Bare `vega` shows an animated brand splash, then help (not an error).
  if (process.argv.length <= 2) {
    await brandIntro();
    process.stdout.write("\n");
    program.outputHelp();
    return;
  }
  await program.parseAsync(process.argv);
}

run().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
