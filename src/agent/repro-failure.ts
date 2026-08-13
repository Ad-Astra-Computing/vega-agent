/**
 * Classifying why a dispatched reproduction failed.
 *
 * Lives here rather than beside the reproduce entry point because that module
 * runs on import: it calls main() at the top level, so a test that imported it
 * for this one function started a reproduction, and in an environment without
 * the required variables it exited the test worker. The suite still printed
 * every test as passing while the run itself exited non-zero.
 *
 * The distinction matters on the server. A build that failed counts once toward
 * a backoff; provenance that cannot name the output is deterministic and retires
 * the candidate at once. Retirement is shared across everyone attesting that
 * output, so this has to be narrow.
 */

/**
 * Does this evaluator output say the attribute does not exist at that reference?
 *
 * Matched on nix's own wording AND on the line being an error rather than
 * anything a build printed. A flake can write whatever it likes to stderr,
 * including this phrase, so a bare substring match over combined output would
 * let a build talk the control plane into retiring a candidate. Requiring the
 * phrase on a line nix marked as an error keeps the judgement with the
 * evaluator.
 *
 * If nix rewords the message this returns false, the failure is reported as an
 * ordinary build failure, and the candidate takes the slower backoff to the same
 * place. Wrong in the safe direction.
 */
export function unresolvableProvenance(evaluatorOutput: string): boolean {
  return /^\s*error:[^\n]*does not provide attribute/im.test(evaluatorOutput);
}
