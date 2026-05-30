import { describe, it, expect } from "vitest";
import { fetchActionsOidcToken } from "../src/agent/oidc.js";
import { ControlPlaneClient } from "../src/agent/client.js";
import { buildAttestBody } from "../src/agent/narinfo.js";
import { lockedInstallable } from "../src/agent/reproduce.js";

/** Minimal fake of fetch that records calls and returns scripted responses. */
function fakeFetch(handler: (req: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const fn = (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    calls.push(req.clone());
    return Promise.resolve(handler(req));
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("fetchActionsOidcToken", () => {
  it("requests the token with the audience and bearer, returns .value", async () => {
    const { fn, calls } = fakeFetch((req) => {
      expect(req.headers.get("authorization")).toBe("Bearer req-token");
      return new Response(JSON.stringify({ value: "the-jwt" }));
    });
    const token = await fetchActionsOidcToken(
      { requestUrl: "https://actions.example/token", requestToken: "req-token" },
      "https://api.vega.io",
      fn,
    );
    expect(token).toBe("the-jwt");
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("audience")).toBe("https://api.vega.io");
  });

  it("throws when the Actions OIDC env vars are missing", async () => {
    const { fn } = fakeFetch(() => new Response("{}"));
    await expect(
      fetchActionsOidcToken({}, "https://api.vega.io", fn),
    ).rejects.toThrow(/id-token|ACTIONS_ID_TOKEN/i);
  });
});

describe("ControlPlaneClient", () => {
  const base = "https://api.vega.io";

  it("requests a presigned upload URL with the bearer token", async () => {
    const { fn, calls } = fakeFetch((req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/api/cache/upload-url");
      expect(req.headers.get("authorization")).toBe("Bearer jwt");
      return new Response(JSON.stringify({ url: "https://r2/put?sig=x" }));
    });
    const client = new ControlPlaneClient(base, "jwt", fn);
    const url = await client.uploadUrl("nar/abc.nar.zst");
    expect(url).toBe("https://r2/put?sig=x");
    expect(JSON.parse(await calls[0]!.text())).toEqual({ narUrl: "nar/abc.nar.zst" });
  });

  it("PUTs NAR bytes to the presigned URL", async () => {
    const { fn, calls } = fakeFetch((req) => {
      expect(req.method).toBe("PUT");
      return new Response(null, { status: 200 });
    });
    const client = new ControlPlaneClient(base, "jwt", fn);
    await client.putNar("https://r2/put?sig=x", new Uint8Array([1, 2, 3]));
    expect(calls[0]!.url).toBe("https://r2/put?sig=x");
  });

  it("posts an attestation and returns the decision", async () => {
    const { fn } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            decision: {
              tenantTier: [{ tenant: "org/a", fingerprint: "fp" }],
              shared: { promoted: true, fingerprint: "fp", reason: "agreement", distinctTenants: 2, weight: 5 },
              diverged: false,
            },
            publishedTenant: true,
            publishedShared: true,
          }),
        ),
    );
    const client = new ControlPlaneClient(base, "jwt", fn);
    const result = await client.attest({
      storePath: "/nix/store/p4pclmv1gyja5kzc26npqpia1qqxrf0l-ruby-2.7.3",
      url: "nar/abc.nar.zst",
      compression: "zstd",
      fileHash: "sha256:aaa",
      fileSize: 1,
      narHash: "sha256:bbb",
      narSize: 2,
      references: [],
    });
    expect(result.decision.shared.promoted).toBe(true);
    expect(result.publishedShared).toBe(true);
  });

  it("throws on a non-2xx response", async () => {
    const { fn } = fakeFetch(() => new Response("nope", { status: 401 }));
    const client = new ControlPlaneClient(base, "jwt", fn);
    await expect(client.uploadUrl("nar/x.nar.zst")).rejects.toThrow(/401/);
  });
});

describe("buildAttestBody", () => {
  it("strips the store dir from references and deriver", () => {
    const body = buildAttestBody(
      {
        path: "/nix/store/p4pclmv1gyja5kzc26npqpia1qqxrf0l-ruby-2.7.3",
        narHash: "sha256:1impfw8zdgisxkghq9a3q7cn7jb9zyzgxdydiamp8z2nlyyl0h5h",
        narSize: 18735072,
        references: [
          "/nix/store/0d71ygfwbmy1xjlbj1v027dfmy9cqavy-libffi-3.3",
          "/nix/store/p4pclmv1gyja5kzc26npqpia1qqxrf0l-ruby-2.7.3",
        ],
        deriver: "/nix/store/bidkcs01mww363s4s7akdhbl6ws66b0z-ruby-2.7.3.drv",
      },
      {
        url: "nar/abc.nar.zst",
        compression: "zstd",
        fileHash: "sha256:fff",
        fileSize: 999,
      },
    );
    expect(body.references).toEqual([
      "0d71ygfwbmy1xjlbj1v027dfmy9cqavy-libffi-3.3",
      "p4pclmv1gyja5kzc26npqpia1qqxrf0l-ruby-2.7.3",
    ]);
    expect(body.deriver).toBe("bidkcs01mww363s4s7akdhbl6ws66b0z-ruby-2.7.3.drv");
    expect(body.storePath).toBe(
      "/nix/store/p4pclmv1gyja5kzc26npqpia1qqxrf0l-ruby-2.7.3",
    );
    expect(body.narHash).toBe(
      "sha256:1impfw8zdgisxkghq9a3q7cn7jb9zyzgxdydiamp8z2nlyyl0h5h",
    );
    expect(body.compression).toBe("zstd");
  });

  it("omits deriver when absent or unknown", () => {
    const body = buildAttestBody(
      {
        path: "/nix/store/p4pclmv1gyja5kzc26npqpia1qqxrf0l-ruby-2.7.3",
        narHash: "sha256:bbb",
        narSize: 2,
        references: [],
        deriver: null,
      },
      { url: "nar/x.nar.zst", compression: "zstd", fileHash: "sha256:fff", fileSize: 1 },
    );
    expect(body.deriver).toBeUndefined();
    expect(body.references).toEqual([]);
  });

  it("carries the flake attribute when given, omits it otherwise", () => {
    const info = {
      path: "/nix/store/p4pclmv1gyja5kzc26npqpia1qqxrf0l-ruby-2.7.3",
      narHash: "sha256:bbb",
      narSize: 2,
      references: [],
      deriver: null,
    };
    const nar = { url: "nar/x.nar.zst", compression: "zstd", fileHash: "sha256:fff", fileSize: 1 };
    expect(buildAttestBody(info, nar, "packages.x86_64-linux.ruby").attr).toBe(
      "packages.x86_64-linux.ruby",
    );
    expect(buildAttestBody(info, nar).attr).toBeUndefined();
    expect(buildAttestBody(info, nar, "").attr).toBeUndefined();
  });
});

describe("lockedInstallable", () => {
  it("locks a github flake ref to /rev#attr", () => {
    expect(
      lockedInstallable({
        flakeRef: "github:owner/repo",
        attr: "packages.x86_64-linux.hello",
        rev: "8b2b57d91dd1f4d094bb944a0a0ef65319a5663f",
      }),
    ).toBe("github:owner/repo/8b2b57d91dd1f4d094bb944a0a0ef65319a5663f#packages.x86_64-linux.hello");
  });

  it("pins a non-github flake ref with ?rev=", () => {
    expect(
      lockedInstallable({ flakeRef: "git+https://example.com/r.git", attr: "x", rev: "deadbeef" }),
    ).toBe("git+https://example.com/r.git?rev=deadbeef#x");
  });

  it("uses & when the ref already carries a query", () => {
    expect(
      lockedInstallable({ flakeRef: "git+https://e.com/r?ref=main", attr: "x", rev: "ddd" }),
    ).toBe("git+https://e.com/r?ref=main&rev=ddd#x");
  });

  it("refuses an installable that would parse as a nix flag", () => {
    expect(() =>
      lockedInstallable({ flakeRef: "--store/ssh://evil", attr: "x", rev: "ddd" }),
    ).toThrow(/looks like a flag/);
  });
});
