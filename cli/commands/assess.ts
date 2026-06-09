import type { Command } from "commander";
import pc from "picocolors";
import { readFile } from "node:fs/promises";
import { DEFAULT_CONTROL_PLANE, assertSafeControlPlane, controlPlaneFor } from "../context.js";
import { info, success, warn, fail, jsonEvent } from "../ui.js";
import { buildToolContext, parseFlagKey } from "../mcp/runtime.js";
import { assessChange } from "../mcp/assess.js";

const MAX_SCAN = 2000; // same cap as the automated MCP surface
const MAX_INPUT_BYTES = 8 * 1024 * 1024; // bound --added-paths input (a closure path list is small)

interface AssessOpts {
  addedPaths: string;
  url: string;
  publicKey?: string;
  json?: boolean;
}

/**
 * Extract the added store paths from `--added-paths` input. Accepts either a bare
 * JSON array of paths, or a `vega gate --json` object with an `added: string[]`
 * field, so the two compose directly: `vega gate .#x --json | vega assess
 * --added-paths -`. Non-string entries are dropped.
 */
export function parseAddedPaths(text: string): string[] {
  const j: unknown = JSON.parse(text);
  const arr = Array.isArray(j)
    ? j
    : j !== null && typeof j === "object" && Array.isArray((j as { added?: unknown }).added)
      ? (j as { added: unknown[] }).added
      : null;
  if (arr === null) {
    throw new Error("expected a JSON array of store paths, or a `vega gate --json` object with an `added` array");
  }
  return arr.filter((p): p is string => typeof p === "string");
}

/** Read stdin to a string, aborting if it exceeds `MAX_INPUT_BYTES` so a runaway
 * or hostile producer cannot exhaust memory. */
async function readAllStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let buf = "";
  for await (const chunk of process.stdin as AsyncIterable<string>) {
    buf += chunk;
    if (buf.length > MAX_INPUT_BYTES) throw new Error(`input exceeds ${MAX_INPUT_BYTES} bytes`);
  }
  return buf;
}

/**
 * `vega assess --added-paths <file>` — a read-only, change-level trust gate. It
 * takes the store paths a change ADDS (already resolved, e.g. piped from `vega
 * gate --json`) and rolls each path's proof-backed Vega verdict up into one
 * allow/warn/deny for the whole change. It resolves nothing and builds nothing;
 * for the build + closure-diff half of the workflow, run `vega gate` first.
 */
export function registerAssess(program: Command): void {
  program
    .command("assess")
    .description("Assess the trust standing of the store paths a change adds (read-only)")
    .requiredOption("--added-paths <file>", "JSON file (or - for stdin) of added paths, e.g. from `vega gate --json`")
    .option("--url <url>", "cache URL", DEFAULT_CONTROL_PLANE)
    .option("--public-key <key>", "trusted key to verify against (overrides nix.conf)")
    .option("--json", "output the full JSON verdict envelope")
    .addHelpText(
      "after",
      "\nCompose with the closure gate:\n" +
        "  vega gate .#mypkg --json | vega assess --added-paths -\n",
    )
    .action(async (opts: AssessOpts) => {
      const cacheUrl = assertSafeControlPlane(controlPlaneFor(opts.url));
      let flagKey;
      try {
        flagKey = parseFlagKey(opts.publicKey);
      } catch {
        fail(`--public-key is not a valid '<name>:<base64>' key`);
      }

      let text: string;
      try {
        text = opts.addedPaths === "-" ? await readAllStdin() : await readFile(opts.addedPaths, "utf8");
      } catch (e) {
        fail(`could not read ${opts.addedPaths}`, [(e as Error).message]);
      }
      if (text.length > MAX_INPUT_BYTES) fail(`--added-paths input exceeds ${MAX_INPUT_BYTES} bytes`);
      let paths: string[];
      try {
        paths = parseAddedPaths(text);
      } catch (e) {
        fail("invalid --added-paths input", [(e as Error).message]);
      }

      const ctx = buildToolContext(cacheUrl, { flagKey, maxScan: MAX_SCAN });
      const result = await assessChange(ctx, paths);

      if (opts.json) {
        jsonEvent(result);
        if (result.verdict === "deny") process.exitCode = 1;
        return;
      }

      const ev = result.evidence;
      for (const p of ev.paths) {
        const mark =
          p.verdict === "allow" ? pc.green("allow") : p.verdict === "warn" ? pc.yellow("warn") : pc.red("deny");
        info(`  ${mark}  ${p.path}  [${p.reasonCodes.join(", ")}]`);
      }
      const line = `${ev.addedClosure.assessed}/${ev.addedClosure.count} assessed, ${ev.summary.verdicts.deny} deny, ${ev.summary.verdicts.warn} warn`;
      if (result.verdict === "allow") {
        success(`change assessment: allow (${line})`);
      } else if (result.verdict === "warn") {
        warn(`change assessment: warn (${line}) [${result.reasonCodes.join(", ")}]`);
        for (const a of result.nextActions) info(a);
      } else {
        fail(`change assessment: deny (${line}) [${result.reasonCodes.join(", ")}]`, result.nextActions);
      }
    });
}
