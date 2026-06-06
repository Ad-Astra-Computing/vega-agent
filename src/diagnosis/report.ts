// Vendored from garnix-ci edge/src/diagnosis (mirrors the canonical classifier,
// same convention as src/nix/*). Keep in sync; do not fork the taxonomy.
import { classifyDiff } from "./classify.js";

/**
 * Programmatic divergence diagnosis. Deterministic, no LLM: Nix surfaces the
 * divergence and `diffoscope` produces the diff; the cause taxonomy + heuristic
 * classifier turn that diff into named causes and their standard fixes. For the
 * common non-determinism sources this is complete on its own — a model would
 * only be a marginal fallback for an unmatched long tail or package-specific
 * patch authoring, and never decides anything.
 */

export interface DiagnosisFinding {
  causeId: string;
  title: string;
  fix: string;
  /** Diff lines that point at this cause. */
  evidence: string[];
}

export interface Diagnosis {
  storePath?: string;
  reproducible: boolean;
  findings: DiagnosisFinding[];
  summary: string;
}

export interface DiagnosisInput {
  diff: string;
  storePath?: string;
}

export function diagnose(input: DiagnosisInput): Diagnosis {
  const findings: DiagnosisFinding[] = classifyDiff(input.diff).map((m) => ({
    causeId: m.cause.id,
    title: m.cause.title,
    fix: m.cause.fix,
    evidence: m.evidence,
  }));

  const summary =
    findings.length === 0
      ? "Build diverged but no known non-determinism cause matched the diff."
      : `Likely cause: ${findings[0]!.title}. ${findings[0]!.fix}`;

  const result: Diagnosis = { reproducible: false, findings, summary };
  if (input.storePath !== undefined) result.storePath = input.storePath;
  return result;
}
