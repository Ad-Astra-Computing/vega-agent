import { describe, it, expect } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchActionsOidcToken } from "../src/agent/oidc.js";
import { ControlPlaneClient } from "../src/agent/client.js";
import { sha256NixBase32, sha256NixHashToBase64 } from "../src/nix/hash.js";
import { buildAttestBody } from "../src/agent/narinfo.js";
import { lockedInstallable } from "../src/agent/reproduce.js";
import { partitionByUpstream } from "../src/agent/upstream.js";
import { resolveBuilds } from "../src/agent/builds.js";
import { parseVegaConfig } from "../src/agent/config.js";

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
    expect(calls[0]!.headers.get("x-amz-checksum-sha256")).toBeNull(); // omitted without a checksum
  });

  it("sends the fileHash so the presigned PUT is bound to its sha256 checksum", async () => {
    const fileHash = sha256NixBase32(new Uint8Array([1, 2, 3]));
    const { fn, calls } = fakeFetch(() => new Response(JSON.stringify({ url: "https://r2/put?sig=x" })));
    const client = new ControlPlaneClient(base, "jwt", fn);
    await client.uploadUrl("nar/abc.nar.zst", fileHash);
    expect(JSON.parse(await calls[0]!.text())).toEqual({ narUrl: "nar/abc.nar.zst", fileHash });
  });

  it("sends x-amz-checksum-sha256 on the NAR PUT when a checksum is given", async () => {
    const fileHash = sha256NixBase32(new Uint8Array([1, 2, 3]));
    const checksum = sha256NixHashToBase64(fileHash);
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const client = new ControlPlaneClient(base, "jwt", fn);
    await client.putNar("https://r2/put?sig=x", new Uint8Array([1, 2, 3]), checksum);
    expect(calls[0]!.headers.get("x-amz-checksum-sha256")).toBe(checksum);
  });

  it("streams a file-backed Blob and re-reads it on retry (replayable, no full-buffer)", async () => {
    const file = join(tmpdir(), `vega-nar-${Math.random().toString(36).slice(2)}.bin`);
    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    await writeFile(file, bytes);
    try {
      let n = 0;
      const bodies: string[] = [];
      const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input as RequestInfo, init);
        bodies.push(Buffer.from(await req.arrayBuffer()).toString("hex"));
        n += 1;
        return n < 2 ? new Response("busy", { status: 503 }) : new Response(null, { status: 200 });
      }) as unknown as typeof fetch;
      const client = new ControlPlaneClient(base, "jwt", fn, fastRetry);
      // openAsBlob is how the agent passes NARs: a file-backed Blob undici streams.
      await client.putNar("https://r2/put?sig=x", await openAsBlob(file));
      expect(n).toBe(2); // 503 then success
      // The Blob was re-read on the retry: both attempts saw the same full bytes.
      expect(bodies).toEqual(["0a141e2832", "0a141e2832"]);
    } finally {
      await rm(file, { force: true });
    }
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

  it("posts an owner push to /api/cache/push and returns the namespace", async () => {
    const { fn, calls } = fakeFetch(
      () => new Response(JSON.stringify({ published: true, tenant: "owner:583231", substituter: "/tenant/owner:583231" })),
    );
    const client = new ControlPlaneClient(base, "owner-cred", fn);
    const result = await client.push({
      storePath: "/nix/store/p4pclmv1gyja5kzc26npqpia1qqxrf0l-ruby-2.7.3",
      url: "nar/abc.nar.zst",
      compression: "zstd",
      fileHash: "sha256:aaa",
      fileSize: 1,
      narHash: "sha256:bbb",
      narSize: 2,
      references: [],
    });
    expect(calls[0]!.url).toBe(`${base}/api/cache/push`);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer owner-cred");
    expect(result.substituter).toBe("/tenant/owner:583231");
  });

  it("throws on a non-2xx response", async () => {
    const { fn } = fakeFetch(() => new Response("nope", { status: 401 }));
    const client = new ControlPlaneClient(base, "jwt", fn);
    await expect(client.uploadUrl("nar/x.nar.zst")).rejects.toThrow(/401/);
  });

  // No-wait retry config for deterministic tests.
  const fastRetry = { attempts: 5, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, jitter: () => 0.5 };

  it("retries a transient 503 and then succeeds", async () => {
    let n = 0;
    const { fn, calls } = fakeFetch(() => {
      n += 1;
      return n < 3
        ? new Response("busy", { status: 503 })
        : new Response(JSON.stringify({ url: "https://r2/put?sig=x" }));
    });
    const client = new ControlPlaneClient(base, "jwt", fn, fastRetry);
    expect(await client.uploadUrl("nar/abc.nar.zst")).toBe("https://r2/put?sig=x");
    expect(calls.length).toBe(3); // two 503s, then success
  });

  it("retries network errors too", async () => {
    let n = 0;
    const fn = (() => {
      n += 1;
      return n < 2 ? Promise.reject(new Error("ECONNRESET")) : Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const client = new ControlPlaneClient(base, "jwt", fn, fastRetry);
    await expect(client.putNar("https://r2/put?sig=x", new Uint8Array([1]))).resolves.toBeUndefined();
    expect(n).toBe(2);
  });

  it("gives up after exhausting retries on a persistent 503", async () => {
    const { fn, calls } = fakeFetch(() => new Response("busy", { status: 503 }));
    const client = new ControlPlaneClient(base, "jwt", fn, fastRetry);
    await expect(client.uploadUrl("nar/x.nar.zst")).rejects.toThrow(/503/);
    expect(calls.length).toBe(5); // attempts cap
  });

  it("does not retry a non-retryable 4xx", async () => {
    const { fn, calls } = fakeFetch(() => new Response("denied", { status: 403 }));
    const client = new ControlPlaneClient(base, "jwt", fn, fastRetry);
    await expect(client.attest({
      storePath: "/nix/store/p4pclmv1gyja5kzc26npqpia1qqxrf0l-ruby-2.7.3",
      url: "nar/abc.nar.zst", compression: "zstd", fileHash: "sha256:aaa",
      fileSize: 1, narHash: "sha256:bbb", narSize: 2, references: [],
    })).rejects.toThrow(/403/);
    expect(calls.length).toBe(1); // no retry on 403
  });

  it("re-mints and retries once when a 401 means the token expired mid-run", async () => {
    const minted: string[] = [];
    const tokenFn = async (force?: boolean) => {
      const t = force ? "fresh" : "old";
      minted.push(t);
      return t;
    };
    const { fn, calls } = fakeFetch((req) =>
      req.headers.get("authorization") === "Bearer fresh"
        ? new Response(JSON.stringify({ url: "https://r2/put?sig=x" }))
        : new Response("expired", { status: 401 }),
    );
    const client = new ControlPlaneClient(base, tokenFn, fn, fastRetry);
    expect(await client.uploadUrl("nar/abc.nar.zst")).toBe("https://r2/put?sig=x");
    expect(calls.length).toBe(2); // first 401 with the stale token, then success with the fresh one
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer old");
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer fresh");
    expect(minted).toEqual(["old", "fresh"]); // the 401 forced a fresh mint
  });

  it("gives up after a second 401 (a real auth failure, not just expiry)", async () => {
    let forced = false;
    const tokenFn = async (force?: boolean) => {
      if (force) forced = true;
      return "stale";
    };
    const { fn, calls } = fakeFetch(() => new Response("denied", { status: 401 }));
    const client = new ControlPlaneClient(base, tokenFn, fn, fastRetry);
    await expect(client.uploadUrl("nar/x.nar.zst")).rejects.toThrow(/401/);
    expect(calls.length).toBe(2); // one forced-fresh retry, then give up
    expect(forced).toBe(true);
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

describe("partitionByUpstream (skip-upstream caching)", () => {
  const NOVEL = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-my-config";
  const STOCK = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-glibc-2.40";

  it("keeps only paths the upstream cache does not already have", async () => {
    const fetchImpl = ((url: string) =>
      Promise.resolve(new Response(null, { status: url.includes("bbbbbbbb") ? 200 : 404 }))) as unknown as typeof fetch;
    const { novel, upstream } = await partitionByUpstream([NOVEL, STOCK], "https://cache.nixos.org", fetchImpl);
    expect(novel).toEqual([NOVEL]);
    expect(upstream).toEqual([STOCK]);
  });

  it("treats an upstream network error as novel (upload rather than drop)", async () => {
    const fetchImpl = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const { novel } = await partitionByUpstream([NOVEL], "https://cache.nixos.org", fetchImpl);
    expect(novel).toEqual([NOVEL]);
  });

  it("preserves order and partitions every path under bounded concurrency", async () => {
    // 200 paths, alternating upstream/novel, with jittered async resolution so a
    // naive shared-index loop would reorder or drop entries if it were wrong.
    const paths = Array.from(
      { length: 200 },
      (_, i) => `/nix/store/${String(i).padStart(32, "0")}-pkg-${i}`,
    );
    const upstreamSet = new Set(paths.filter((_, i) => i % 2 === 0));
    const fetchImpl = ((url: string) =>
      new Promise((resolve) =>
        // resolve out of order: later requests sometimes finish first
        setTimeout(
          () => {
            const hash = url.split("/").pop()!.replace(".narinfo", "");
            const path = paths.find((p) => p.includes(hash.slice(0, 32)));
            resolve(new Response(null, { status: path && upstreamSet.has(path) ? 200 : 404 }));
          },
          Math.floor((url.length * 7) % 5),
        ),
      )) as unknown as typeof fetch;
    const { novel, upstream } = await partitionByUpstream(paths, "https://cache.nixos.org", fetchImpl, 8);
    // Every path classified exactly once, order preserved within each bucket.
    expect(novel.length + upstream.length).toBe(paths.length);
    expect(upstream).toEqual(paths.filter((p) => upstreamSet.has(p)));
    expect(novel).toEqual(paths.filter((p) => !upstreamSet.has(p)));
  });

  it("checks upstream even when concurrency is given as zero (clamps to >= 1)", async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls++;
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    const { upstream } = await partitionByUpstream([NOVEL, STOCK], "https://cache.nixos.org", fetchImpl, 0);
    expect(calls).toBe(2); // not skipped: zero workers would have checked nothing
    expect(upstream).toEqual([NOVEL, STOCK]);
  });
});

describe("resolveBuilds (vega.yaml drives what is built)", () => {
  it("falls back to the CLI installable when there is no vega.yaml", () => {
    expect(resolveBuilds(null, "github:NixOS/nixpkgs#hello", "/repo")).toEqual([
      { installable: "github:NixOS/nixpkgs#hello", attr: "hello" },
    ]);
  });

  it("resolves one installable per declared build against the flake dir", () => {
    const cfg = parseVegaConfig({
      builds: ["packages.x86_64-linux.mytool", { attr: "nixosConfigurations.h.config.system.build.toplevel" }],
    });
    expect(resolveBuilds(cfg, ".#", "/home/runner/work/repo/repo/")).toEqual([
      { installable: "/home/runner/work/repo/repo#packages.x86_64-linux.mytool", attr: "packages.x86_64-linux.mytool" },
      {
        installable: "/home/runner/work/repo/repo#nixosConfigurations.h.config.system.build.toplevel",
        attr: "nixosConfigurations.h.config.system.build.toplevel",
      },
    ]);
  });

  it("expands declared devShells to devShells.<system>.<name> for the runner system", () => {
    const cfg = parseVegaConfig({ builds: ["hello"], devShells: ["default", "rust"] });
    expect(resolveBuilds(cfg, ".#", "/repo", "x86_64-linux")).toEqual([
      { installable: "/repo#hello", attr: "hello" },
      { installable: "/repo#devShells.x86_64-linux.default", attr: "devShells.x86_64-linux.default" },
      { installable: "/repo#devShells.x86_64-linux.rust", attr: "devShells.x86_64-linux.rust" },
    ]);
  });

  it("requires currentSystem when devShells are declared", () => {
    const cfg = parseVegaConfig({ builds: ["hello"], devShells: ["default"] });
    expect(() => resolveBuilds(cfg, ".#", "/repo")).toThrow(/currentSystem/);
  });

  it("expands include matchers over flake outputs and applies exclude to the whole set", () => {
    const cfg = parseVegaConfig({
      builds: ["packages.x86_64-linux.keepme"],
      include: ["packages.x86_64-linux.*"],
      exclude: ["packages.x86_64-linux.broken"],
    });
    const outputs = [
      "packages.x86_64-linux.hello",
      "packages.x86_64-linux.broken",
      "checks.x86_64-linux.test",
    ];
    expect(resolveBuilds(cfg, ".#", "/repo", undefined, outputs).map((b) => b.attr)).toEqual([
      "packages.x86_64-linux.keepme",
      "packages.x86_64-linux.hello",
    ]);
  });

  it("requires flakeOutputs when include matchers are declared", () => {
    const cfg = parseVegaConfig({ include: ["packages.*.*"] });
    expect(() => resolveBuilds(cfg, ".#", "/repo")).toThrow(/flakeOutputs/);
  });
});
