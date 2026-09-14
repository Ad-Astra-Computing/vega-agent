import { describe, it, expect, vi } from "vitest";
import {
  sanitizeForTerminal,
  parseGroups,
  formatGroup,
  decideExit,
  fetchBlockingGroups,
  EXIT_OK,
  EXIT_BLOCKING,
  EXIT_AUTH_OR_TRANSPORT_ERROR,
  type BlockingGroup,
} from "./diagnose.js";
import type { StoredCredential } from "../context.js";

const CRED: StoredCredential = {
  credential: "tok",
  login: "acme",
  userId: "1",
  expiresAt: Date.now() + 3_600_000,
  url: "https://vega-cache.dev",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("sanitizeForTerminal", () => {
  it("strips an ANSI colour escape", () => {
    const raw = "before\x1b[31mRED\x1b[0mafter";
    expect(sanitizeForTerminal(raw)).toBe("beforeREDafter");
  });

  it("strips a cursor-move / screen-clear escape sequence", () => {
    const raw = "line one\x1b[2J\x1b[Hline two";
    expect(sanitizeForTerminal(raw)).toBe("line oneline two");
  });

  it("strips a bidirectional override so text cannot render reordered", () => {
    const raw = "safe\u202Eevil\u202Cend";
    expect(sanitizeForTerminal(raw)).toBe("safeevilend");
  });

  it("keeps newline and tab so a multi-line excerpt still reads as one", () => {
    const raw = "line one\nindented\ttab";
    expect(sanitizeForTerminal(raw)).toBe(raw);
  });
});

describe("parseGroups", () => {
  it("keeps a well-formed group", () => {
    const groups = parseGroups({
      groups: [{ drv: "/nix/store/x-y.drv", diagnosis: "network", candidateCount: 3, excerpt: "boom" }],
    });
    expect(groups).toEqual([{ drv: "/nix/store/x-y.drv", diagnosis: "network", candidateCount: 3, excerpt: "boom" }]);
  });

  it("drops an entry missing its derivation or diagnosis rather than guessing", () => {
    const groups = parseGroups({ groups: [{ diagnosis: "network", candidateCount: 1, excerpt: null }] });
    expect(groups).toEqual([]);
  });

  it("returns an empty list for a malformed body", () => {
    expect(parseGroups(null)).toEqual([]);
    expect(parseGroups({})).toEqual([]);
    expect(parseGroups({ groups: "not-an-array" })).toEqual([]);
  });
});

describe("formatGroup", () => {
  it("attributes the excerpt to the builder, never to Vega, and never prints an escape sequence raw", () => {
    const g: BlockingGroup = {
      drv: "/nix/store/x-nix-update-notifier.drv",
      diagnosis: "impure-host-path",
      candidateCount: 37,
      excerpt: "sips: \x1b[31moperation not permitted\x1b[0m",
    };
    const lines = formatGroup(g).join("\n");
    expect(lines).toContain("from the builder's own output, not Vega's");
    expect(lines).not.toContain("\x1b[31m");
    expect(lines).toContain("operation not permitted");
  });

  it("labels an unrecognised diagnosis plainly rather than failing", () => {
    const g: BlockingGroup = { drv: "/nix/store/x.drv", diagnosis: "made-up", candidateCount: 1, excerpt: null };
    const lines = formatGroup(g).join("\n");
    expect(lines).toContain("unclassified failure");
  });
});

describe("decideExit", () => {
  it("exits 0 with blockers present and the flag absent", () => {
    expect(decideExit([{ drv: "d", diagnosis: "network", candidateCount: 1, excerpt: null }], false)).toBe(EXIT_OK);
  });

  it("exits 1 with blockers present and --fail-on-blocking", () => {
    expect(decideExit([{ drv: "d", diagnosis: "network", candidateCount: 1, excerpt: null }], true)).toBe(
      EXIT_BLOCKING,
    );
  });

  it("exits 0 under --fail-on-blocking when there is nothing to report", () => {
    expect(decideExit([], true)).toBe(EXIT_OK);
  });
});

describe("fetchBlockingGroups (auth/transport outcomes)", () => {
  it("reports an error, distinct from EXIT_BLOCKING, for no stored credential", async () => {
    const result = await fetchBlockingGroups(null, vi.fn());
    expect(result.ok).toBe(false);
    expect(EXIT_AUTH_OR_TRANSPORT_ERROR).not.toBe(EXIT_BLOCKING);
  });

  it("reports an error for an expired credential without ever calling fetch", async () => {
    const expired = { ...CRED, expiresAt: 1000 };
    const fetchImpl = vi.fn();
    const result = await fetchBlockingGroups(expired, fetchImpl, () => 2000);
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports an error when the network call itself throws", async () => {
    const result = await fetchBlockingGroups(CRED, vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("ECONNREFUSED");
  });

  it("reports an error on a non-2xx response (e.g. a revoked credential)", async () => {
    const result = await fetchBlockingGroups(CRED, vi.fn().mockResolvedValue(jsonResponse({ error: "invalid token" }, 401)));
    expect(result.ok).toBe(false);
  });

  it("returns the parsed groups on success, scoped to whatever the server returned for this credential", async () => {
    const body = { groups: [{ drv: "/nix/store/x.drv", diagnosis: "timeout", candidateCount: 2, excerpt: null }] };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body));
    const result = await fetchBlockingGroups(CRED, fetchImpl);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.groups).toEqual(body.groups);
    // The bearer credential authenticates the request; the URL carries no owner parameter.
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://vega-cache.dev/api/repro/blocking");
    expect(url).not.toContain("owner=");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });
});
