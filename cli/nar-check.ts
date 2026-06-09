import { createZstdDecompress } from "node:zlib";
import { Readable } from "node:stream";
import { verifyNarHash } from "../src/nix/verify.js";
import type { NarInfo } from "../src/nix/types.js";

/** A fetch that yields a streaming Response, for the (possibly large) NAR body. */
export type NarFetch = (path: string) => Promise<Response>;

/**
 * Re-derive the uncompressed NAR hash from the cache's actual bytes and compare
 * it to the signed claim. A valid signature and transparency record only bind a
 * narinfo; re-deriving the NAR is what proves the served bytes ARE the ones that
 * were signed. Without this, a signed/logged narinfo pointing at corrupt or
 * substituted NAR bytes would still look "verified". Streams the body so memory
 * stays constant; the caller bounds runtime with a fetch timeout.
 *
 * Shared by the `vega verify` command and the `vega mcp` tools so the two can
 * never disagree on what "verified" means.
 */
export async function checkNarHash(
  fetchNar: NarFetch,
  info: Pick<NarInfo, "url" | "compression" | "narHash">,
): Promise<{ ok: boolean; checked: boolean; detail: string }> {
  // `checked: false` means the byte check was NOT PERFORMED (we cannot decompress
  // this format, or the NAR could not be fetched), which is distinct from a hash
  // MISMATCH (`ok: false, checked: true`). A caller must not treat "not checked"
  // as "verified", nor as "refuted": it is simply unverified locally.
  if (info.compression !== "zstd" && info.compression !== "none") {
    return { ok: false, checked: false, detail: `unsupported compression '${info.compression}' for local check` };
  }
  const res = await fetchNar(`/${info.url}`);
  if (!res.ok || res.body === null) return { ok: false, checked: false, detail: `NAR fetch failed (HTTP ${res.status})` };
  let stream: ReadableStream<Uint8Array>;
  if (info.compression === "zstd") {
    const compressed = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    stream = Readable.toWeb(compressed.pipe(createZstdDecompress())) as ReadableStream<Uint8Array>;
  } else {
    stream = res.body;
  }
  const r = await verifyNarHash(info.narHash, stream);
  return r.ok
    ? { ok: true, checked: true, detail: r.actual }
    : { ok: false, checked: true, detail: `signed ${r.expected}, content ${r.actual}` };
}
