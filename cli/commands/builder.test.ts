import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuilderEnroll, builderList, builderRemove, type BuilderDeps } from "./builder.js";

function deps(respond: (req: Request) => Response) {
  const events: string[] = [];
  const seen: Request[] = [];
  const d: BuilderDeps = {
    url: "https://vega.test",
    token: async () => {
      events.push("token");
      return "gh";
    },
    fetch: (async (input: string, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push(req.clone());
      events.push(`${req.method} ${new URL(req.url).pathname}`);
      return respond(req);
    }) as typeof fetch,
  };
  return { d, events, seen, say: (l: string) => void events.push(`say:${l}`) };
}

const ok = () =>
  new Response(JSON.stringify({ credential: "cred-xyz", label: "rack", login: "owner", expiresAt: Date.UTC(2027, 1, 23) }), { status: 200 });

describe("vega builder enroll (spec 0009)", () => {
  it("states what the heartbeat sends and asks, before signing in or sending anything", async () => {
    const { d, events, say } = deps(ok);
    const dir = mkdtempSync(join(tmpdir(), "vb-"));
    const r = await runBuilderEnroll(d, "rack", { out: join(dir, "c"), yes: false, ask: async () => (events.push("ask"), false), say });
    expect(r).toBe("declined");
    const before = events.slice(0, events.indexOf("ask")).join(" ");
    expect(before).toMatch(/every minute while its runner is up/);
    expect(before).toMatch(/no IP address/);
    expect(before).toContain("/privacy#builders");
    expect(events).not.toContain("token");
  });

  it("writes the credential to a file only its owner can read, and refuses to overwrite one", async () => {
    const { d, say, seen } = deps(ok);
    const dir = mkdtempSync(join(tmpdir(), "vb-"));
    const out = join(dir, "rack.credential");
    expect(await runBuilderEnroll(d, "rack", { out, yes: true, ask: async () => true, say })).toBe("enrolled");
    expect(readFileSync(out, "utf8")).toBe("cred-xyz\n");
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(await seen[0]!.json()).toEqual({ label: "rack" });
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer gh");
  });

  it("refuses an existing file before asking for a credential, so the current one is not revoked", async () => {
    const { d, events, say } = deps(ok);
    const dir = mkdtempSync(join(tmpdir(), "vb-"));
    const out = join(dir, "rack.credential");
    writeFileSync(out, "the credential in use\n");
    await expect(runBuilderEnroll(d, "rack", { out, yes: true, ask: async () => true, say })).rejects.toThrow(/already exists/);
    expect(events.filter((e) => e === "token" || e.startsWith("POST"))).toEqual([]);
    expect(readFileSync(out, "utf8")).toBe("the credential in use\n");
  });

  it("leaves no empty file behind when the control plane refuses", async () => {
    const { d, say } = deps(() => new Response(JSON.stringify({ error: "no" }), { status: 409 }));
    const dir = mkdtempSync(join(tmpdir(), "vb-"));
    const out = join(dir, "c");
    await expect(runBuilderEnroll(d, "rack", { out, yes: true, ask: async () => true, say })).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a bad label before asking anything", async () => {
    const { d, events, say } = deps(ok);
    await expect(runBuilderEnroll(d, "a:b", { out: "/nonexistent/x", yes: true, ask: async () => true, say })).rejects.toThrow(/label/);
    expect(events).toEqual([]);
  });

  it("passes the control plane's refusal on", async () => {
    const { d, say } = deps(() => new Response(JSON.stringify({ error: "this account already has 5 builders" }), { status: 409 }));
    const dir = mkdtempSync(join(tmpdir(), "vb-"));
    await expect(runBuilderEnroll(d, "rack", { out: join(dir, "c"), yes: true, ask: async () => true, say })).rejects.toThrow(/5 builders/);
  });
});

describe("vega builder list and remove", () => {
  it("lists and removes by label", async () => {
    const { d, seen } = deps((req) =>
      req.method === "GET"
        ? new Response(JSON.stringify({ builders: [{ label: "rack", enrolledAt: 1, expiresAt: 2 }] }), { status: 200 })
        : new Response(JSON.stringify({ removed: true }), { status: 200 }),
    );
    expect(await builderList(d)).toEqual([{ label: "rack", enrolledAt: 1, expiresAt: 2 }]);
    expect(await builderRemove(d, "rack")).toBe(true);
    expect(await seen[1]!.json()).toEqual({ label: "rack" });
    expect(seen[1]!.method).toBe("DELETE");
  });
});
