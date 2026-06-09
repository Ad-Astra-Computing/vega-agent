import type { Command } from "commander";
import { DEFAULT_CONTROL_PLANE, assertSafeControlPlane, controlPlaneFor } from "../context.js";
import { fail } from "../ui.js";
import { parsePublicKey } from "../../src/nix/signing.js";
import { runStdio } from "../mcp/server.js";
import { buildToolContext } from "../mcp/runtime.js";

const MCP_MAX_SCAN = 2000; // default cap for automated MCP calls

export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description("Run a read-only MCP server exposing Vega verification to AI agents (stdio)")
    .option("--url <url>", "cache URL", DEFAULT_CONTROL_PLANE)
    .option("--public-key <key>", "trusted key to verify against (overrides nix.conf)")
    .option("--max-scan <n>", "max transparency-log entries to scan", (v) => Number(v))
    .addHelpText(
      "after",
      "\nAdd to an MCP client (e.g. Claude Code) as a stdio server:\n" +
        '  { "command": "vega", "args": ["mcp"] }\n' +
        "Tools: vega_verify, vega_risk, vega_reproduce, vega_assess_change (all read-only).",
    )
    .action(async (opts: { url: string; publicKey?: string; maxScan?: number }) => {
      const cacheUrl = assertSafeControlPlane(controlPlaneFor(opts.url));
      // Resolve an explicit key once, up front, so a bad value fails before the
      // server starts speaking the protocol on stdout.
      let flagKey = null as ReturnType<typeof parsePublicKey> | null;
      if (opts.publicKey) {
        try {
          flagKey = parsePublicKey(opts.publicKey);
        } catch {
          fail(`--public-key is not a valid '<name>:<base64>' key`);
        }
      }
      let maxScan = MCP_MAX_SCAN;
      if (opts.maxScan !== undefined) {
        if (!Number.isInteger(opts.maxScan) || opts.maxScan <= 0) {
          fail(`--max-scan must be a positive integer`);
        }
        maxScan = opts.maxScan;
      }
      // Diagnostics go to stderr; stdout is reserved for JSON-RPC.
      process.stderr.write(`vega mcp: serving over stdio against ${cacheUrl}\n`);
      await runStdio(buildToolContext(cacheUrl, { flagKey, maxScan }));
    });
}
