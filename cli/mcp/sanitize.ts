/**
 * Untrusted-output handling for the Vega MCP server.
 *
 * Every string Vega reports about a build (store-path basenames, builder ids,
 * revocation reasons, divergence diffs) is attacker-influencable data that flows
 * straight into a coding agent's context. That is exactly OWASP LLM01 (prompt
 * injection) and LLM05 (improper output handling), and the MCP-specific
 * tool-poisoning class: a malicious builder could embed "ignore previous
 * instructions..." in a path name or a divergence diff.
 *
 * We never present such data as instructions. Tool results keep these values in
 * clearly-typed `untrusted` fields, and every one is run through `untrusted()`:
 * control characters (including ANSI escapes that could spoof terminal/markdown
 * formatting) are stripped, and length is capped so a huge diff can't flood the
 * context (LLM10, unbounded consumption).
 */

/** True for C0 controls (incl. ESC 0x1b), DEL (0x7f), and C1 controls (0x80-0x9f). */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** Sanitize one cache-reported string for safe inclusion in a tool result. */
export function untrusted(value: unknown, maxLen = 256): string {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) {
    out += isControl(ch.codePointAt(0) ?? 0) ? " " : ch;
  }
  if (out.length > maxLen) out = out.slice(0, maxLen) + "…[truncated]";
  return out;
}

/** Sanitize an array of untrusted strings, bounding both element and list size. */
export function untrustedList(values: unknown, maxItems = 50, maxLen = 256): string[] {
  if (!Array.isArray(values)) return [];
  return values.slice(0, maxItems).map((v) => untrusted(v, maxLen));
}
