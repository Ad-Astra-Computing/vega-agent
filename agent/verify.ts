// Independent cache verifier (Node). Fetches a published narinfo and its NAR from
// a vega cache, decompresses the NAR, and re-derives narHash to confirm the
// stored content matches the signed claim. A proactive consistency auditor —
// run it as a cron/batch job over the cache, not in the Worker hot path.
//
// Usage: node_modules/.bin/tsx agent/verify.ts <cache-base-url> <store-path-hash>
//
// The decompression (node:zlib zstd) is the Node-only boundary; the comparison
// logic is the tested src/nix/verify.ts.

import { createZstdDecompress } from "node:zlib";
import { Readable } from "node:stream";
import { parseNarInfo } from "../src/nix/narinfo.js";
import { verifyNarHash } from "../src/nix/verify.js";

async function main(): Promise<void> {
  const base = process.argv[2];
  const hash = process.argv[3];
  if (!base || !hash) {
    console.error("usage: verify <cache-base-url> <store-path-hash>");
    process.exit(2);
  }
  const baseUrl = base.endsWith("/") ? base : `${base}/`;

  const narinfoRes = await fetch(`${baseUrl}${hash}.narinfo`);
  if (!narinfoRes.ok) throw new Error(`narinfo fetch failed: ${narinfoRes.status}`);
  const info = parseNarInfo(await narinfoRes.text());

  const narRes = await fetch(`${baseUrl}${info.url}`);
  if (!narRes.ok || narRes.body === null) {
    throw new Error(`NAR fetch failed: ${narRes.status}`);
  }

  // compressed web stream -> node stream -> zstd decompress -> web stream
  const compressed = Readable.fromWeb(narRes.body as Parameters<typeof Readable.fromWeb>[0]);
  const decompressed = compressed.pipe(createZstdDecompress());
  const uncompressed = Readable.toWeb(decompressed) as ReadableStream<Uint8Array>;

  const result = await verifyNarHash(info.narHash, uncompressed);
  if (result.ok) {
    console.log(`ok  ${info.storePath}  ${result.actual}`);
    process.exit(0);
  } else {
    console.error(
      `MISMATCH ${info.storePath}\n  signed:   ${result.expected}\n  content:  ${result.actual}`,
    );
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
