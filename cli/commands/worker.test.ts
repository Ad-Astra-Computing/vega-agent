import { describe, it, expect } from "vitest";
import { contactSet, contactShow, contactRemove, type ContactDeps } from "./worker.js";

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
    expect(await seen[0]!.json()).toEqual({ address: "Jane@Example.ORG" });
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
