/** Mitigates CVE-2026-111497 (Brotli decoder RCE) until nixpkgs ships a patched
 * Node. Requesting `identity` is only a hint a hostile server can ignore, so
 * this checks the response's Content-Encoding and refuses the body outright
 * rather than letting fetch's lazy decompression run on it. */
export async function fetchUncompressed(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  // Headers via the real constructor, not an object spread: a caller's headers
  // may be a Headers instance or a [k, v][] array, neither of which `{...x}`
  // copies, and either form would otherwise lose every header it carried.
  const headers = new Headers(init.headers);
  headers.set("accept-encoding", "identity");
  const res = await fetch(input, { ...init, headers });
  const enc = res.headers.get("content-encoding");
  if (enc !== null && enc.toLowerCase() !== "identity") {
    // Drain and discard rather than read: do not hand the body to any decoder.
    await res.body?.cancel();
    throw new Error(
      `refusing a response compressed as '${enc}': the body is never decoded locally (CVE-2026-111497)`,
    );
  }
  return res;
}
