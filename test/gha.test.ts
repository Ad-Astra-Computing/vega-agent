import { describe, it, expect } from "vitest";
import { escapeWorkflowData, workflowWarning } from "../src/agent/gha.js";

describe("escapeWorkflowData", () => {
  it("escapes %, CR, and LF so a command cannot be split", () => {
    expect(escapeWorkflowData("a%b\rc\nd")).toBe("a%25b%0Dc%0Ad");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeWorkflowData("possible github-token in /nix/store/x-out:3")).toBe(
      "possible github-token in /nix/store/x-out:3",
    );
  });
});

describe("workflowWarning", () => {
  it("emits a single ::warning:: line even when the message embeds a newline", () => {
    const line = workflowWarning("found in evil\n::error::forged");
    // Exactly one ::warning::, and no raw newline that the runner could parse as
    // a second command. The forged ::error:: is neutralized to inert text.
    expect(line.startsWith("::warning::")).toBe(true);
    expect(line).not.toContain("\n");
    expect(line).toContain("%0A::error::forged");
    expect(line.match(/::warning::/g)).toHaveLength(1);
  });
});
