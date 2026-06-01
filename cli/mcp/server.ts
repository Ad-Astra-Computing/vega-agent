/**
 * Minimal MCP stdio server for Vega. Hand-rolled JSON-RPC 2.0 over
 * newline-delimited stdio (the MCP stdio transport) rather than pulling the SDK,
 * to keep the dependency/attack surface minimal and fully auditable (OWASP
 * LLM03, supply chain) for a security tool. The wire surface is tiny:
 * `initialize`, `tools/list`, `tools/call`, plus `ping` and notifications.
 *
 * Tool descriptions are plain and honest — no hidden instructions (the
 * tool-poisoning defense is "don't be a poisoned tool"). All tools are
 * read-only; `tools/call` only ever dispatches to the verify/risk handlers.
 */

import { verifyTool, riskTool, isError, type ToolContext } from "./tools.js";
import { untrusted } from "./sanitize.js";

const PROTOCOL_VERSION = "2025-06-18";
const MAX_FRAME = 8 * 1024 * 1024; // reject a stdin line larger than this

const TARGET_SCHEMA = {
  type: "object",
  properties: {
    target: {
      type: "string",
      description: "A /nix/store path, a store-path hash, or <hash>.narinfo.",
    },
  },
  required: ["target"],
  additionalProperties: false,
} as const;

const TOOLS: {
  name: string;
  description: string;
  inputSchema: unknown;
  run: (ctx: ToolContext, input: { target: string }) => Promise<unknown>;
}[] = [
  {
    name: "vega_verify",
    description:
      "Independently verify a Nix store path against the Vega cache: checks the " +
      "cache signature against a key you already trust (from your nix.conf), the " +
      "signed transparency-log tree head, and the build's RFC 9162 inclusion " +
      "proof. Returns proof-backed facts. Read-only; installs nothing.",
    inputSchema: TARGET_SCHEMA,
    run: verifyTool,
  },
  {
    name: "vega_risk",
    description:
      "Return an allow/warn/deny gate for a Nix store path, with proof-backed " +
      "reason codes (e.g. TRANSPARENCY_LOG_INCLUDED, INCLUSION_PROOF_FAILED) and " +
      "suggested next actions, so an agent or CI can decide whether to use, " +
      "install, or depend on it. Read-only; every verdict is backed by " +
      "cryptographic facts, never a heuristic score.",
    inputSchema: TARGET_SCHEMA,
    run: riskTool,
  },
];

interface Rpc {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { name?: unknown; arguments?: unknown } & Record<string, unknown>;
}

/** Handle one JSON-RPC request. Returns the response object, or null for a
 * JSON-RPC notification (no `id`), which never gets a reply. Never throws: tool
 * exceptions become an isError result, and anything else a -32603 error. */
export async function handleRpc(ctx: ToolContext, req: Rpc): Promise<object | null> {
  if (req.id === undefined) return null; // notification: no response
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: req.id, error: { code, message } });

  try {
    switch (req.method) {
      case "initialize":
        return ok({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "vega", version: "0.1.0" },
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      case "tools/call": {
        const name = req.params?.name;
        const args = (req.params?.arguments ?? {}) as { target?: unknown };
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return fail(-32602, `unknown tool: ${untrusted(String(name), 64)}`);
        if (typeof args.target !== "string") return fail(-32602, "missing required string argument 'target'");
        let out: unknown;
        try {
          out = await tool.run(ctx, { target: args.target });
        } catch (e) {
          // A throwing cache (malformed narinfo/proof JSON, etc.) is a tool
          // result error, not a protocol crash.
          out = { error: untrusted(e instanceof Error ? e.message : "tool error", 200) };
        }
        return ok({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: isError(out) });
      }
      default:
        return fail(-32601, `method not found: ${untrusted(String(req.method), 64)}`);
    }
  } catch {
    return fail(-32603, "internal error");
  }
}

/** Run the server over stdin/stdout until EOF. Newline-delimited JSON-RPC. */
export async function runStdio(ctx: ToolContext): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buf = "";
  for await (const chunk of process.stdin as AsyncIterable<string>) {
    buf += chunk;
    // Drop a runaway frame that never delimits, so memory stays bounded.
    if (buf.length > MAX_FRAME && buf.indexOf("\n") < 0) {
      buf = "";
      continue;
    }
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || line.length > MAX_FRAME) continue;
      let req: Rpc;
      try {
        req = JSON.parse(line) as Rpc;
      } catch {
        continue; // ignore malformed lines
      }
      const res = await handleRpc(ctx, req);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    }
  }
}

export { TOOLS };
