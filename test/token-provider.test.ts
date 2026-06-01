import { describe, it, expect } from "vitest";
import { OidcTokenProvider, jwtExpSeconds } from "../src/agent/token-provider.js";

/** Build a syntactically-valid JWT with a given `exp` (no real signature). */
function fakeJwt(exp: number, nonce = 0): string {
  const b64url = (o: unknown): string =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "RS256" })}.${b64url({ exp, nonce })}.sig`;
}

describe("jwtExpSeconds", () => {
  it("decodes the exp claim without verifying", () => {
    expect(jwtExpSeconds(fakeJwt(1893456000))).toBe(1893456000);
  });
  it("returns null for a malformed token or missing exp", () => {
    expect(jwtExpSeconds("not.a.jwt-without-exp")).toBeNull();
    expect(jwtExpSeconds("only-one-segment")).toBeNull();
    const noExp = `${btoa('{"alg":"RS256"}')}.${btoa('{"sub":"x"}')}.sig`;
    expect(jwtExpSeconds(noExp)).toBeNull();
  });
});

describe("OidcTokenProvider", () => {
  it("mints on first get and returns the token", async () => {
    let calls = 0;
    const now = 1_000_000_000_000; // fixed ms
    const p = new OidcTokenProvider(async () => fakeJwt(now / 1000 + 600, ++calls), 60, () => now);
    const tok = await p.get();
    expect(calls).toBe(1);
    expect(jwtExpSeconds(tok)).toBe(now / 1000 + 600);
  });

  it("returns the cached token while it is comfortably valid", async () => {
    let calls = 0;
    const now = 1_000_000_000_000;
    const p = new OidcTokenProvider(async () => fakeJwt(now / 1000 + 600, ++calls), 60, () => now);
    const a = await p.get();
    const b = await p.get();
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it("re-mints when the token is within the skew window of expiry", async () => {
    let calls = 0;
    let clock = 1_000_000_000_000; // ms
    // Each mint issues a token valid for 600s from the current clock.
    const p = new OidcTokenProvider(async () => fakeJwt(clock / 1000 + 600, ++calls), 60, () => clock);
    await p.get(); // calls === 1, exp = t0 + 600
    clock += 580_000; // 580s later: now+skew(60) = 640 > 600 -> refresh
    const second = await p.get();
    expect(calls).toBe(2);
    expect(jwtExpSeconds(second)).toBe(clock / 1000 + 600);
  });

  it("re-mints once the token has fully expired", async () => {
    let calls = 0;
    let clock = 1_000_000_000_000;
    const p = new OidcTokenProvider(async () => fakeJwt(clock / 1000 + 300, ++calls), 60, () => clock);
    await p.get(); // calls === 1
    clock += 3_000_000; // 3000s later: long expired
    await p.get();
    expect(calls).toBe(2);
  });

  it("treats a token with no readable exp as short-lived and refreshes", async () => {
    let calls = 0;
    let clock = 1_000_000_000_000;
    const p = new OidcTokenProvider(async () => `no.exp-${++calls}.sig`, 60, () => clock);
    await p.get(); // calls 1; fallback exp = now+240
    clock += 250_000; // past the 240s fallback
    await p.get();
    expect(calls).toBe(2);
  });
});
