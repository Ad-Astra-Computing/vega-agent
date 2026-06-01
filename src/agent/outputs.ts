/**
 * Garnix-style attribute matching for `vega.yaml` include/exclude. Pure, so the
 * agent keeps the `nix flake show` call and this stays unit-testable.
 *
 * A matcher is a dotted attribute path with `*` wildcards, e.g.
 * `packages.x86_64-linux.*` or `*.*`. `*` matches one path component (any run of
 * characters except the `.` separator), and the matcher must match the WHOLE
 * attribute path. "Build everything matching `include`, minus `exclude`."
 *
 * Matching is a linear two-pointer wildcard scan per component (O(n*m), no
 * backtracking) rather than a compiled regex, to avoid ReDoS on hostile globs.
 */

const MAX_DEPTH = 32;
const MAX_OUTPUTS = 20000;

/** Linear single-segment wildcard match: `*` matches any run of characters. */
function segMatch(pat: string, s: string): boolean {
  let p = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    if (p < pat.length && pat[p] === s[i]) {
      p++;
      i++;
    } else if (p < pat.length && pat[p] === "*") {
      star = p;
      mark = i;
      p++;
    } else if (star !== -1) {
      p = star + 1;
      i = ++mark;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}

/** True if the dotted `glob` matches the whole dotted `attr` path. */
export function attrMatch(glob: string, attr: string): boolean {
  const g = glob.split(".");
  const a = attr.split(".");
  if (g.length !== a.length) return false;
  for (let i = 0; i < g.length; i++) {
    if (!segMatch(g[i]!, a[i]!)) return false;
  }
  return true;
}

/** True if `attr` matches any of the globs. */
export function matchesAnyGlob(attr: string, globs: string[]): boolean {
  return globs.some((g) => attrMatch(g, attr));
}

/** Outputs matching any `include` matcher and no `exclude` matcher. */
export function matchOutputs(all: string[], include: string[], exclude: string[]): string[] {
  return all.filter((p) => matchesAnyGlob(p, include) && !matchesAnyGlob(p, exclude));
}

/**
 * Flatten `nix flake show --json` output to a list of attribute paths. A node is
 * a leaf when it carries a `type` string (e.g. `derivation`,
 * `nixos-configuration`); everything above it is a namespace to recurse into.
 * Iterative with depth + output caps, so a deeply-nested or huge flake-show JSON
 * cannot stack-overflow or blow up memory.
 */
export function flattenFlakeShow(tree: unknown): string[] {
  const out: string[] = [];
  const stack: { node: unknown; path: string[] }[] = [{ node: tree, path: [] }];
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (typeof node !== "object" || node === null || path.length > MAX_DEPTH) continue;
    const o = node as Record<string, unknown>;
    if (typeof o.type === "string") {
      if (path.length > 0 && out.length < MAX_OUTPUTS) out.push(path.join("."));
      continue;
    }
    for (const [k, v] of Object.entries(o)) {
      if (out.length >= MAX_OUTPUTS) break;
      stack.push({ node: v, path: [...path, k] });
    }
  }
  return out;
}
