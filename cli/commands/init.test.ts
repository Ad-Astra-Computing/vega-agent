import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderWorkflow, DEFAULT_ATTR, WORKFLOW_PATH } from "./init.js";

describe("vega init", () => {
  it("examples/vega-cache.yml equals the scaffolded default recipe (no drift)", () => {
    const example = readFileSync(
      fileURLToPath(new URL("../../examples/vega-cache.yml", import.meta.url)),
      "utf8",
    );
    expect(renderWorkflow(DEFAULT_ATTR)).toBe(example);
  });

  it("substitutes the build attribute into the installable", () => {
    const wf = renderWorkflow("packages.aarch64-darwin.tool");
    expect(wf).toContain('installable: "${{ github.workspace }}#packages.aarch64-darwin.tool"');
  });

  it("pins every action to a 40-char commit SHA, never a mutable tag", () => {
    const uses = [...renderWorkflow(DEFAULT_ATTR).matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });

  it("emits least privilege and never runs on pull_request", () => {
    const wf = renderWorkflow(DEFAULT_ATTR);
    expect(wf).toContain("contents: read");
    expect(wf).toContain("id-token: write");
    expect(wf).toContain("persist-credentials: false");
    // No pull_request trigger (the string appears only in an explanatory comment).
    expect(wf).not.toMatch(/^\s+pull_request:/m);
  });

  it("targets the conventional workflow path", () => {
    expect(WORKFLOW_PATH).toBe(".github/workflows/vega-cache.yml");
  });
});
