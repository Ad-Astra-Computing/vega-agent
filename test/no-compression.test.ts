// CVE-2026-111497: Node's fetch() decodes Brotli lazily on body read, and a
// server picks Content-Encoding regardless of what the request asked for.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync } from "node:zlib";
import { fetchUncompressed } from "../src/http/no-compression.js";
import { boundedFetcher, buildToolContext } from "../cli/mcp/runtime.js";
import { ControlPlaneClient } from "../src/agent/client.js";

describe("fetchUncompressed", () => {
  let server: Server;
  let origin: string;
  let encoding: string | undefined;
  let requestedAcceptEncoding: string | undefined;
  let requestedProbeHeader: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      requestedAcceptEncoding = req.headers["accept-encoding"];
      requestedProbeHeader = req.headers["x-probe"] as string | undefined;
      const headers: Record<string, string> = { "content-type": "text/plain" };
      if (encoding !== undefined) headers["content-encoding"] = encoding;
      res.writeHead(200, headers).end(encoding === "br" ? brotliCompressSync(Buffer.from("payload")) : "payload");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server?.close());

  it("asks for identity encoding", async () => {
    encoding = undefined;
    await fetchUncompressed(origin);
    expect(requestedAcceptEncoding).toBe("identity");
  });

  it("passes through an uncompressed response", async () => {
    encoding = undefined;
    const res = await fetchUncompressed(origin);
    expect(await res.text()).toBe("payload");
  });

  it("keeps a caller's header passed as a Headers instance", async () => {
    // {...init.headers} would silently drop every entry a Headers instance
    // carries; init.headers has to go through the real Headers constructor.
    encoding = undefined;
    await fetchUncompressed(origin, { headers: new Headers({ "x-probe": "from-headers-instance" }) });
    expect(requestedProbeHeader).toBe("from-headers-instance");
    expect(requestedAcceptEncoding).toBe("identity");
  });

  it("keeps a caller's header passed as a [k, v][] tuple array", async () => {
    encoding = undefined;
    await fetchUncompressed(origin, { headers: [["x-probe", "from-tuple-array"]] });
    expect(requestedProbeHeader).toBe("from-tuple-array");
    expect(requestedAcceptEncoding).toBe("identity");
  });

  it("passes through a response explicitly marked identity", async () => {
    encoding = "identity";
    const res = await fetchUncompressed(origin);
    expect(await res.text()).toBe("payload");
  });

  it("refuses a response the server compressed anyway, without reading it", async () => {
    encoding = "br";
    await expect(fetchUncompressed(origin)).rejects.toThrow(/CVE-2026-111497/);
  });

  it("a malicious server ignoring Accept-Encoding: identity still gets refused", async () => {
    // The attack this whole module exists to stop: fetchUncompressed asked for
    // identity, the server sent br anyway (exactly what a hostile cache would
    // do), and the fix must still hold.
    encoding = "br";
    await expect(fetchUncompressed(origin)).rejects.toThrow();
    expect(requestedAcceptEncoding).toBe("identity");
  });
});

// The four crafted streams from the published PoC (hypnguyen1209/CVE-2026-111497),
// which drive an unpatched decoder past an invalid block switch instead of a
// clean rejection: two abort the connection, two return truncated/corrupted
// output rather than erroring. Run here against the real bytes, not a stand-in
// compressed string, so this proves the fix against the actual exploit shape.
const POC_PAYLOADS: [string, Buffer][] = [
  ["oob-base", Buffer.from("200010414141fcffff07002228f00b60f7f41f000000", "hex")],
  ["oob-extended", Buffer.from("200010414141fcffff07002228f00b60f7f41f00000000", "hex")],
  ["oob-huffman", Buffer.from("200018414141fcffff07002228f00b60f7f41f000000", "hex")],
  ["oob-padding", Buffer.from("200010414141fcffff0f002228f00b60f7f41f000000", "hex")],
];

describe("fetchUncompressed against the published PoC payloads", () => {
  let server: Server;
  let origin: string;
  let current: Buffer;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-encoding": "br" }).end(current);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server?.close());

  it.each(POC_PAYLOADS)("refuses %s before the decoder ever sees it", async (_tag, payload) => {
    current = payload;
    await expect(fetchUncompressed(origin)).rejects.toThrow(/CVE-2026-111497/);
  });
});

describe("the cache-facing fetchers refuse a compressed response", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res
        .writeHead(200, { "content-type": "application/json", "content-encoding": "br" })
        .end(brotliCompressSync(Buffer.from("{}")));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server?.close());

  it("boundedFetcher refuses rather than decoding a compressed narinfo", async () => {
    const fetcher = boundedFetcher(origin, 4096);
    await expect(fetcher("/some.narinfo")).rejects.toThrow(/CVE-2026-111497/);
  });

  it("buildToolContext's NAR fetcher refuses rather than decoding a compressed NAR", async () => {
    const ctx = buildToolContext(origin);
    await expect(
      ctx.verifyNar({ url: "/some.nar", compression: "none", narHash: "sha256:" + "a".repeat(52) }),
    ).rejects.toThrow(/CVE-2026-111497/);
  });

  it("ControlPlaneClient's default fetcher refuses a compressed control-plane response", async () => {
    const client = new ControlPlaneClient(origin, "jwt");
    await expect(client.uploadUrl("nar/x", "sha256:y")).rejects.toThrow(/CVE-2026-111497/);
  });
});
