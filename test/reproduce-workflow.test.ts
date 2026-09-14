import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

// The reusable workflow in this repo is a separate file from the one the control
// plane dispatches, so a byte comparison cannot police it. What must not drift is
// the contract: the agent reads a set of VEGA_* variables, and every one of them
// has to arrive from a declared input. Deriving the set from the agent source
// means adding a variable there fails here until the workflow carries it.
const WORKFLOW = ".github/workflows/reproduce.yml";
const AGENT = "agent/reproduce.ts";

// Not passed in: VEGA_URL is hardcoded so the OIDC token can only reach Vega, and
// VEGA_AUDIENCE defaults to it.
const SUPPLIED_BY_THE_JOB = new Set(["VEGA_URL", "VEGA_AUDIENCE"]);

function envReadByTheAgent(): string[] {
  const source = readFileSync(AGENT, "utf8");
  const names = new Set<string>();
  for (const m of source.matchAll(/\bVEGA_[A-Z_]+\b/g)) {
    if (!SUPPLIED_BY_THE_JOB.has(m[0])) names.add(m[0]);
  }
  return [...names].sort();
}

const workflow = parse(readFileSync(WORKFLOW, "utf8"));
const triggers = workflow.on ?? workflow[true as unknown as string];
const steps = workflow.jobs.reproduce.steps as Array<Record<string, any>>;
const attest = steps.find((s) => typeof s.env?.VEGA_FLAKE_REF === "string");

describe("the reusable reproducer workflow", () => {
  it("passes every variable the agent reads", () => {
    expect(attest).toBeDefined();
    for (const name of envReadByTheAgent()) {
      expect(Object.keys(attest!.env)).toContain(name);
    }
  });

  it("declares every input it forwards, on both triggers", () => {
    const referenced = new Set<string>();
    for (const value of Object.values(attest!.env as Record<string, string>)) {
      for (const m of String(value).matchAll(/\$\{\{\s*inputs\.([a-z_]+)\s*\}\}/g)) {
        referenced.add(m[1]!);
      }
    }
    expect(referenced.size).toBeGreaterThan(0);
    for (const input of referenced) {
      expect(Object.keys(triggers.workflow_dispatch.inputs)).toContain(input);
      expect(Object.keys(triggers.workflow_call.inputs)).toContain(input);
    }
  });

  it("installs dependencies without running their scripts", () => {
    // This job holds the OIDC token that gates signing, so a dependency's install
    // script would run with it in reach.
    const install = steps.find((s) => typeof s.run === "string" && s.run.includes("npm ci"));
    expect(install).toBeDefined();
    expect(install!.run).toContain("--ignore-scripts");
  });
});
