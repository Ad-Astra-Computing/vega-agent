import { describe, it, expect, afterEach } from "vitest";
import { discoverTenant } from "../cli/commands/verify.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Mock fetch by URL substring -> Response. */
function mockFetch(routes: Record<string, () => Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [frag, make] of Object.entries(routes)) {
      if (url.includes(frag)) return make();
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const BASE = "https://vega-cache.dev";
const HASH = "awh4ga7z2xvfk1xbzqskn1bkjwvh9782";

describe("discoverTenant", () => {
  it("resolves a single tenant and fetches its narinfo", async () => {
    mockFetch({
      "/api/status/": () => new Response(JSON.stringify({ tenants: ["jasonodoom/nixos-configs"] })),
      "/tenant/jasonodoom/nixos-configs/": () => new Response("StorePath: /nix/store/x\n"),
    });
    const found = await discoverTenant(BASE, HASH);
    expect(found?.url).toBe("https://vega-cache.dev/tenant/jasonodoom/nixos-configs");
    expect(found?.narText).toContain("StorePath:");
  });

  it("returns null when no tenant holds the build", async () => {
    mockFetch({ "/api/status/": () => new Response(JSON.stringify({ tenants: [] })) });
    expect(await discoverTenant(BASE, HASH)).toBeNull();
  });

  it("returns null when the status lookup itself fails", async () => {
    mockFetch({ "/api/status/": () => new Response("nope", { status: 500 }) });
    expect(await discoverTenant(BASE, HASH)).toBeNull();
  });

  it("ignores malformed and path-traversal tenant identifiers from the status response", async () => {
    mockFetch({
      // A "." / ".." segment must not be accepted: URL normalization would
      // collapse it to escape /tenant/.
      "/api/status/": () =>
        new Response(
          JSON.stringify({ tenants: ["../etc/passwd", "https://evil", "org/..", "./repo", "org/../x", ".."] }),
        ),
    });
    expect(await discoverTenant(BASE, HASH)).toBeNull();
  });
});
