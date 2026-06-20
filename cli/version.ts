/** The running `vega` version. Kept in sync with package.json by a test (so it
 * cannot drift on a release); `vega doctor` compares it to the latest published
 * tag to report staleness. */
export const VERSION = "0.10.0";

/** The agent repo whose releases `vega doctor` checks against. */
export const AGENT_REPO = "Ad-Astra-Computing/vega-agent";

/** Compare dotted numeric versions (a leading `v` is ignored). Returns -1 if a <
 * b, 0 if equal, 1 if a > b. Non-numeric components are treated as 0. */
export function compareVersions(a: string, b: string): number {
  const parse = (s: string): number[] => s.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
