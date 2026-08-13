import { describe, it, expect } from "vitest";
import { composeReport, hashOf, issueUrl } from "./commands/report.js";
import type { Check } from "./commands/doctor.js";

const checks: Check[] = [
  { name: "nix", level: "ok", detail: "nix (Nix) 2.34.7" },
  { name: "auth", level: "warn", detail: "not enrolled" },
];
const base = {
  checks,
  version: "0.15.0",
  platform: "linux-x64",
  controlPlane: "https://vega-cache.dev",
  auth: "enrolled" as const,
  at: "2026-08-13T00:00:00.000Z",
};

describe("what a report carries", () => {
  it("carries the machine's setup, which is what makes a report answerable", () => {
    const body = composeReport(base);
    expect(body).toContain("vega 0.15.0 on linux-x64");
    expect(body).toContain("ok   nix: nix (Nix) 2.34.7");
    expect(body).toContain("warn auth: enrolled");
  });

  it("says the credential's state and never who holds it", () => {
    // Filing an issue reveals the reporter's identity anyway. Pasting the login
    // in makes that this command's decision rather than theirs, and the enrolled
    // account is not always the filing account.
    //
    // The fixture carries what doctor REALLY produces when enrolled, which is
    // "enrolled as <login>". An earlier version of this test used the
    // not-enrolled string and so proved nothing: it passed while the login went
    // into the report.
    const enrolled: Check[] = [{ name: "auth", level: "ok", detail: "enrolled as octocat" }];
    const body = composeReport({ ...base, checks: enrolled, auth: "enrolled" });
    expect(body).toContain("credential: enrolled");
    expect(body).toContain("auth: enrolled");
    expect(body).not.toContain("octocat");
  });

  it("includes an output only when asked, with its public verdict", () => {
    expect(composeReport(base)).not.toContain("output:");
    const body = composeReport({ ...base, hash: "p4pclmv1gyja5kzc26npqpia1qqxrf0l", verdict: "uncorroborated" });
    expect(body).toContain("output: p4pclmv1gyja5kzc26npqpia1qqxrf0l (uncorroborated)");
  });

  it("quotes error text the reader passed, and nothing it went looking for", () => {
    const body = composeReport({ ...base, error: "error: builder failed" });
    expect(body).toContain("error text (pasted by hand)");
    expect(body).toContain("error: builder failed");
  });

  it("sends security problems somewhere that is not a public tracker", () => {
    expect(composeReport(base)).toContain("security@adastracomputing.com");
  });

  it("carries no logs, no environment and no config, whatever is passed", () => {
    // The rule that matters most: a journal from a machine that builds other
    // people's code can hold a presigned URL or a token fragment, and a public
    // tracker is scraped continuously.
    const body = composeReport({ ...base, error: "one line the user pasted" });
    expect(body).not.toMatch(/process\.env|VEGA_[A-Z_]*=|\/home\/[a-z]+\/\.config|Authorization|Bearer /);
  });
});

describe("naming an output", () => {
  it("accepts a store path or a bare hash", () => {
    expect(hashOf("/nix/store/p4pclmv1gyja5kzc26npqpia1qqxrf0l-hello-2.12")).toBe(
      "p4pclmv1gyja5kzc26npqpia1qqxrf0l",
    );
    expect(hashOf("p4pclmv1gyja5kzc26npqpia1qqxrf0l")).toBe("p4pclmv1gyja5kzc26npqpia1qqxrf0l");
  });

  it("refuses anything else rather than putting it in a URL", () => {
    expect(hashOf("../../etc/passwd")).toBeNull();
    expect(hashOf("not a hash")).toBeNull();
    expect(hashOf("")).toBeNull();
  });
});

describe("the issue link", () => {
  it("escapes the body so it cannot break out of the query", () => {
    const url = issueUrl("t", "a&b=c#d e");
    expect(url).toContain("body=a%26b%3Dc%23d%20e");
    expect(url.startsWith("https://github.com/")).toBe(true);
  });
});

describe("the verdict vocabulary matches the control plane", () => {
  // A previous version of this list named "reproduced", which the server never
  // sends, and omitted "reproducible", which is what a promoted output gets. So
  // the report dropped the verdict most worth reporting, silently.
  it("keeps a verdict the server actually answers with", () => {
    for (const v of ["reproducible", "diverged", "uncorroborated", "mirrored", "unknown"]) {
      const body = composeReport({ ...base, hash: "p4pclmv1gyja5kzc26npqpia1qqxrf0l", verdict: v });
      expect(body).toContain(`(${v})`);
    }
  });
});
