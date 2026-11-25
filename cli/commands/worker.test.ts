import { describe, it, expect } from "vitest";
import { contactSet, contactShow, contactRemove, runContactSet, statusLines, fleetLines, workerStatus, WORKER_ALERT_TERMS, type ContactDeps, type WorkerStatus } from "./worker.js";

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
    expect(terms).toMatch(/reproduction workers or enrolled builders/);
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

describe("vega worker status (spec 0008)", () => {
  const NOW = Date.parse("2026-11-28T12:00:00Z");
  const body: WorkerStatus = {
    release: { latest: "0.3.0", required: { version: "0.2.0", from: "2026-11-27", reason: "Fixes a store leak." } },
    workers: [
      { label: "box-a", deployment: "host", version: "0.3.0", state: "current", lastSeen: NOW - 120_000, reporting: true },
      { label: "box-b", deployment: "microvm", version: "0.1.0", state: "below-minimum", lastSeen: NOW - 5_400_000, reporting: false },
    ],
  };

  it("asks the status route with the GitHub token", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const d = {
      url: "https://vega.test",
      token: async () => "gh",
      fetch: (async (url: string, init?: RequestInit) => {
        seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
        return new Response(JSON.stringify(body), { status: 200 });
      }) as typeof fetch,
    };
    expect(await workerStatus(d)).toEqual(body);
    expect(seen).toEqual([{ url: "https://vega.test/api/worker/status", auth: "Bearer gh" }]);
  });

  it("leads with a summary, then the release, then an aligned table", () => {
    const out = statusLines(body, NOW);
    expect(out[0]).toBe("2 reproduction workers, 1 reporting");
    expect(out[1]).toBe("Latest vega-repro-worker 0.3.0. Vega requires 0.2.0 since 27 Nov 2026: Fixes a store leak.");
    expect(out[2]).toBe("");
    expect(out[3]).toMatch(/^WORKER\s+DEPLOYMENT\s+VERSION\s+STATE\s+STATUS\s+LAST REPORT$/);
    expect(out[4]).toMatch(/^box-a\s+host\s+0\.3\.0\s+current\s+reporting\s+2 min ago$/);
    expect(out[5]).toMatch(/^box-b\s+microvm\s+0\.1\.0\s+below minimum, given no work\s+silent\s+1 h 30 min ago$/);
    // Columns line up: each header starts where its cells do.
    expect(out[3]!.indexOf("STATE")).toBe(out[4]!.indexOf("current"));
    expect(out[3]!.indexOf("LAST REPORT")).toBe(out[5]!.indexOf("1 h 30 min ago"));
  });

  it("closes with what to do when a worker needs an update, and says nothing when none does", () => {
    expect(statusLines(body, NOW).at(-1)).toBe(
      "1 worker needs an update: https://docs.vega-cache.dev/contribute#updating-your-worker",
    );
    const fine: WorkerStatus = { release: { latest: "0.3.0" }, workers: [body.workers[0]!] };
    expect(statusLines(fine, NOW).join("\n")).not.toContain("needs an update");
  });

  it("colours what needs attention when a style is given", () => {
    const tag = (n: string) => (s: string) => `<${n}>${s}</${n}>`;
    const out = statusLines(body, NOW, { title: tag("b"), header: tag("g"), good: tag("ok"), warn: tag("w"), bad: tag("x"), dim: tag("d") }).join("\n");
    expect(out).toContain("<b>2 reproduction workers, 1 reporting</b>");
    expect(out).toContain("<ok>current");
    expect(out).toContain("<x>below minimum, given no work");
    expect(out).toContain("<w>silent");
  });

  it("prints nothing a worker reported that could drive the terminal", () => {
    const hostile: WorkerStatus = {
      release: { latest: "0.3.0", required: { version: "0.2.0", from: "2026-11-27", reason: "a\u001b]8;;x\u0007b" } },
      workers: [{ label: "box\u001b[2J", deployment: "host\u202e", version: "0.1\u001b[31m", state: "unknown", lastSeen: NOW, reporting: true }],
    };
    const lines = statusLines(hostile, NOW);
    for (const l of lines) expect(l).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    const out = lines.join("\n");
    expect(out).toContain("box[2J");
  });

  it("says plainly when the account has no worker", () => {
    const out = statusLines({ release: { latest: "0.3.0" }, workers: [] }, NOW);
    expect(out[0]).toBe("No reproduction worker has reported under your account.");
  });
});

describe("the alert terms revision", () => {
  it("is the one that names builders, which the control plane requires", () => {
    expect(WORKER_ALERT_TERMS).toBe("2026-12-19.2");
  });
});

describe("vega fleet status (spec 0009)", () => {
  const NOW = Date.parse("2026-11-28T12:00:00Z");
  const both: WorkerStatus = {
    release: { latest: "0.3.0" },
    workers: [{ label: "box-a", deployment: "host", version: "0.3.0", state: "current", lastSeen: NOW - 120_000, reporting: true }],
    builderRelease: { latest: "0.26.0" },
    builders: [{ label: "rack-1", deployment: "container", version: "0.24.0", state: "behind", lastSeen: NOW - 60_000, reporting: true }],
  };

  it("shows workers, then builders, each with its own release and update guide", () => {
    const out = fleetLines(both, NOW).join("\n");
    expect(out).toContain("1 reproduction worker, 1 reporting");
    expect(out).toContain("Latest vega-repro-worker 0.3.0.");
    expect(out).toContain("1 builder, 1 reporting");
    expect(out).toContain("Latest vega-agent 0.26.0.");
    expect(out).toMatch(/rack-1\s+container\s+0\.24\.0\s+update available\s+reporting\s+1 min ago/);
    expect(out).toContain("1 builder needs an update: https://docs.vega-cache.dev/heavy-builds#updating-your-builder");
    expect(out.indexOf("reproduction worker")).toBeLessThan(out.indexOf("builder,"));
  });

  it("never tells a builder below the minimum that Vega gives it no work, since GitHub assigns its jobs", () => {
    const low = { ...both, builders: [{ ...both.builders[0]!, version: "0.1.0", state: "below-minimum" as const }] };
    const out = fleetLines(low, NOW).join("\n");
    expect(out).toMatch(/rack-1\s+container\s+0\.1\.0\s+below minimum, update now\s+reporting/);
    expect(out).not.toMatch(/rack-1.*given no work/);
  });

  it("leaves out a kind the account has none of, and says so when it has neither", () => {
    expect(fleetLines({ ...both, builders: [] }, NOW).join("\n")).not.toContain("builder");
    expect(fleetLines({ ...both, workers: [] }, NOW).join("\n")).not.toContain("reproduction worker");
    expect(fleetLines({ release: { latest: "0.3.0" }, workers: [], builders: [] }, NOW)[0]).toBe(
      "No worker or builder has reported under your account.",
    );
  });

  it("works with a control plane that predates builders", () => {
    const out = fleetLines({ release: both.release, workers: both.workers }, NOW).join("\n");
    expect(out).toContain("1 reproduction worker, 1 reporting");
    expect(out).not.toContain("builder");
  });
});
