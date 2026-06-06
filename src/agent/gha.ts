/**
 * GitHub Actions workflow-command helpers. The runner parses lines of the form
 * `::command::data` from a step's stdout/stderr, so any attacker-influenced text
 * interpolated into one must be escaped, or a newline in that text splits the
 * line and injects a SECOND, forged command. This is the same escaping GitHub's
 * own @actions/core toolkit applies to command data.
 */

/** Escape the DATA portion of a workflow command (`%`, CR, LF). */
export function escapeWorkflowData(data: string): string {
  return data.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Build a `::warning::` line with its message safely escaped. */
export function workflowWarning(message: string): string {
  return `::warning::${escapeWorkflowData(message)}`;
}
