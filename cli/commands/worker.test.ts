import { describe, it, expect } from "vitest";
import { contactSet, contactShow, contactRemove, runContactSet, WORKER_ALERT_TERMS, type ContactDeps } from "./worker.js";

function deps(respond: (req: Request) => Response): { d: ContactDeps; seen: Request[] } {
  const seen: Request[] = [];
  return {
    seen,
    d: {
      url: "https://vega-cache.dev",
      token: async () => "gh-token",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        seen.push(req.clone());
        return respond(req);
      }) as typeof fetch,
    },
  };
}

describe("vega worker contact", () => {
  it("set posts the address with the GitHub token", async () => {
    const { d, seen } = deps(() => new Response(JSON.stringify({ status: "accepted" }), { status: 202 }));
    await contactSet(d, "  Jane@Example.ORG ");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe("https://vega-cache.dev/api/worker/contact");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer gh-token");
    expect(await seen[0]!.json()).toEqual({ address: "Jane@Example.ORG", consent: WORKER_ALERT_TERMS });
  });

  it("set refuses something that is not an address before asking for a token", async () => {
    let asked = false;
    const { d, seen } = deps(() => new Response(null, { status: 202 }));
    d.token = async () => {
      asked = true;
      return "gh-token";
    };
    await expect(contactSet(d, "not an address")).rejects.toThrow(/email address/);
    expect(asked).toBe(false);
    expect(seen).toEqual([]);
  });

  it("set reports a refusal from the control plane", async () => {
    const { d } = deps(() => new Response(JSON.stringify({ error: "not invited: reproduction workers are invite-only" }), { status: 403 }));
    await expect(contactSet(d, "jane@example.org")).rejects.toThrow(/invite-only/);
  });

  it("show returns the state and the masked address", async () => {
    const { d, seen } = deps(() => new Response(JSON.stringify({ state: "confirmed", address: "j***@example.org" })));
    expect(await contactShow(d)).toEqual({ state: "confirmed", address: "j***@example.org" });
    expect(seen[0]!.method).toBe("GET");
  });

  it("remove sends DELETE and accepts 204", async () => {
    const { d, seen } = deps(() => new Response(null, { status: 204 }));
    await contactRemove(d);
    expect(seen[0]!.method).toBe("DELETE");
  });
});

describe("vega worker contact set: terms before sending", () => {
  function traced() {
    const events: string[] = [];
    const { d, seen } = deps(() => new Response(null, { status: 202 }));
    d.token = async () => {
      events.push("token");
      return "gh-token";
    };
    const inner = d.fetch;
    d.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      events.push("send");
      return inner(i, init);
    }) as typeof fetch;
    const say = (line: string) => void events.push(`say:${line}`);
    return { d, seen, events, say };
  }

  it("shows the terms, then asks, and sends nothing when the answer is no", async () => {
    const { d, seen, events, say } = traced();
    const r = await runContactSet(d, "jane@example.org", { yes: false, ask: async () => (events.push("ask"), false), say });
    expect(r).toBe("declined");
    expect(seen).toEqual([]);
    expect(events).not.toContain("token");
    const firstAsk = events.indexOf("ask");
    expect(events.slice(0, firstAsk).join(" ")).toContain("/privacy#worker-alerts");
  });

  it("names every kind of message the address receives before asking", async () => {
    const { d, events, say } = traced();
    await runContactSet(d, "jane@example.org", { yes: false, ask: async () => (events.push("ask"), false), say });
    const terms = events.slice(0, events.indexOf("ask")).map((e) => e.replace(/^say:/, "")).join(" ");
    expect(terms).toMatch(/stops reporting/);
    expect(terms).toMatch(/reports again/);
    expect(terms).toMatch(/each version Vega requires, when one of them runs an older release/);
  });

  it("with --yes still shows the terms before signing in or sending", async () => {
    const { d, events, say } = traced();
    const r = await runContactSet(d, "jane@example.org", { yes: true, ask: async () => { throw new Error("must not ask"); }, say });
    expect(r).toBe("sent");
    const firstTerms = events.findIndex((e) => e.includes("/privacy#worker-alerts"));
    expect(firstTerms).toBeGreaterThanOrEqual(0);
    expect(firstTerms).toBeLessThan(events.indexOf("token"));
    expect(events.indexOf("token")).toBeLessThan(events.indexOf("send"));
  });

  it("refuses a bad address before showing terms or asking", async () => {
    const { d, events, say } = traced();
    await expect(runContactSet(d, "nope", { yes: false, ask: async () => true, say })).rejects.toThrow(/email address/);
    expect(events).toEqual([]);
  });
});
