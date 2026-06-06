// Vendored from garnix-ci edge/src/diagnosis (mirrors the canonical classifier,
// same convention as src/nix/*). Keep in sync; do not fork the taxonomy.
import { CAUSES, type NonDeterminismCause } from "./causes.js";

export interface CauseMatch {
  cause: NonDeterminismCause;
  /** Diff lines that matched at least one signature of this cause. */
  evidence: string[];
  /** Number of distinct signatures that matched (ranking key). */
  score: number;
}

/**
 * Fast heuristic classifier over a diff (e.g. diffoscope output). Ranks likely
 * non-determinism causes before any LLM call: cheap, deterministic triage that
 * both short-circuits the obvious cases and grounds the LLM prompt. Not
 * authoritative — the LLM refines; neither touches the promotion decision.
 */
export function classifyDiff(diff: string): CauseMatch[] {
  const lines = diff.split("\n");
  const matches: CauseMatch[] = [];

  for (const cause of CAUSES) {
    const evidence = new Set<string>();
    let score = 0;
    for (const sig of cause.signatures) {
      let matchedThisSig = false;
      for (const line of lines) {
        if (sig.test(line)) {
          evidence.add(line.trim());
          matchedThisSig = true;
        }
      }
      if (matchedThisSig) score += 1;
    }
    if (score > 0) {
      matches.push({ cause, evidence: [...evidence], score });
    }
  }

  return matches.sort((a, b) => b.score - a.score || b.evidence.length - a.evidence.length);
}
