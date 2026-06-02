import { describe, it, expect } from "vitest";
import { handleRpc, decodeFrame } from "./server.js";
import type { ToolContext } from "./tools.js";

// A stub context whose cache always 404s, so tool calls resolve to a structured
// error without needing the full crypto scenario (that's covered in tools.test).
const ctx: ToolContext = {
  fetcher: async () => ({ ok: false, status: 404, text: async () => "", json: async () => ({}) }),
  cacheUrl: "https://vega-cache.dev",
  sharedKeyName: "vega-cache-1",
  resolveKey: async () => null,
  verifyNar: async () => ({ ok: false, detail: "not fetched" }),
};

const req = (id: number | null | undefined, method: string, params?: unknown) =>
  ({ jsonrpc: "2.0", id, method, params }) as Parameters<typeof handleRpc>[1];

describe("MCP server protocol", () => {
  it("answers initialize with protocol version + serverInfo", async () => {
    const r = (await handleRpc(ctx, req(1, "initialize"))) as any;
    expect(r.id).toBe(1);
    expect(r.result.serverInfo.name).toBe("vega");
    expect(typeof r.result.protocolVersion).toBe("string");
    expect(r.result.capabilities.tools).toBeDefined();
  });

  it("lists exactly the read-only verify + risk tools", async () => {
    const r = (await handleRpc(ctx, req(2, "tools/list"))) as any;
    const names = r.result.tools.map((t: any) => t.name);
    expect(names).toEqual(["vega_verify", "vega_risk"]);
    expect(r.result.tools[0].inputSchema.required).toEqual(["target"]);
  });

  it("dispatches tools/call and wraps the result as MCP content", async () => {
    const r = (await handleRpc(ctx, req(3, "tools/call", { name: "vega_verify", arguments: { target: "abc123def456abc123def456abc123de" } }))) as any;
    expect(r.result.content[0].type).toBe("text");
    expect(r.result.isError).toBe(true); // 404 from the stub -> structured error
  });

  it("rejects an unknown tool and a missing argument", async () => {
    const unknown = (await handleRpc(ctx, req(4, "tools/call", { name: "evil", arguments: {} }))) as any;
    expect(unknown.error.code).toBe(-32602);
    const missing = (await handleRpc(ctx, req(5, "tools/call", { name: "vega_verify", arguments: {} }))) as any;
    expect(missing.error.code).toBe(-32602);
  });

  it("turns a throwing cache into an isError result, never a crash", async () => {
    const throwing: ToolContext = { ...ctx, fetcher: async () => { throw new Error("boom\x1b[31m"); } };
    const r = (await handleRpc(throwing, req(7, "tools/call", { name: "vega_risk", arguments: { target: "abc123def456abc123def456abc123de" } }))) as any;
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).not.toContain("\x1b"); // error message sanitized
  });

  it("stays silent on notifications and 404s unknown methods", async () => {
    expect(await handleRpc(ctx, req(undefined, "notifications/initialized"))).toBeNull();
    const r = (await handleRpc(ctx, req(6, "does/not/exist"))) as any;
    expect(r.error.code).toBe(-32601);
  });
});

describe("decodeFrame", () => {
  const code = (d: ReturnType<typeof decodeFrame>) =>
    d && "errorResponse" in d ? (d.errorResponse as any).error.code : undefined;
  it("returns -32700 for malformed JSON", () => {
    expect(code(decodeFrame("{not json"))).toBe(-32700);
  });
  it("returns -32600 for a non-object frame", () => {
    expect(code(decodeFrame("123"))).toBe(-32600);
    expect(code(decodeFrame("[1,2]"))).toBe(-32600);
  });
  it("returns -32600 for an oversized frame", () => {
    expect(code(decodeFrame('{"a":"' + "x".repeat(9 * 1024 * 1024) + '"}'))).toBe(-32600);
  });
  it("skips a blank line", () => {
    expect(decodeFrame("   ")).toBeNull();
  });
  it("passes a valid request through", () => {
    const d = decodeFrame('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    expect(d && "req" in d && d.req.method).toBe("ping");
  });
});
