import type { Command } from "commander";
import { DEFAULT_CONTROL_PLANE, assertSafeControlPlane, controlPlaneFor } from "../context.js";
import { fail } from "../ui.js";
import { parsePublicKey } from "../../src/nix/signing.js";
import { trustedKeys, pickTrustedKey } from "../keys.js";
import { runStdio } from "../mcp/server.js";
import type { ToolContext } from "../mcp/tools.js";
import type { Fetcher } from "../verify-core.js";
import { checkNarHash } from "../nar-check.js";

const SHARED_KEY_NAME = "vega-cache-1";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // narinfo/sth/entry/proof are tiny
const MCP_MAX_SCAN = 2000; // default cap for automated MCP calls
const REQUEST_TIMEOUT_MS = 15_000; // small bodies; fail fast on a stalled cache
const NAR_TIMEOUT_MS = 120_000; // NARs can be large but must still terminate

/** A fetcher that aborts any response exceeding `maxBytes`, so a hostile cache
 * cannot exhaust memory by returning a giant narinfo/proof/entry body, and times
 * out a stalled response so a single call cannot hang the serial stdio server. */
function boundedFetcher(base: string, maxBytes: number): Fetcher {
  return async (path) => {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    let body: string | null = null;
    const read = async (): Promise<string> => {
      if (body !== null) return body;
      const reader = res.body?.getReader();
      if (!reader) return (body = "");
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error("response exceeds size limit");
        }
        chunks.push(value);
      }
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        buf.set(c, off);
        off += c.byteLength;
      }
      return (body = new TextDecoder().decode(buf));
    };
    return { ok: res.ok, status: res.status, text: read, json: async () => JSON.parse(await read()) };
  };
}

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
        "Tools: vega_verify, vega_risk (both read-only).",
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
      const ctx: ToolContext = {
        fetcher: boundedFetcher(cacheUrl, MAX_RESPONSE_BYTES),
        cacheUrl,
        sharedKeyName: SHARED_KEY_NAME,
        maxScan,
        resolveKey: async (sigNames) => flagKey ?? pickTrustedKey(await trustedKeys(), sigNames),
        // Streaming NAR fetch (decompress + hash), bounded by a timeout rather
        // than a byte cap since a legitimate NAR can be large.
        verifyNar: (info) =>
          checkNarHash((p) => fetch(`${cacheUrl}${p}`, { signal: AbortSignal.timeout(NAR_TIMEOUT_MS) }), info),
      };
      await runStdio(ctx);
    });
}
