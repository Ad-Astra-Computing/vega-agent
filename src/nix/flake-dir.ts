/**
 * Sanitize the optional subflake directory (`?dir=<sub>`) carried in a build's
 * provenance, for monorepos whose flake lives in a subdirectory (e.g.
 * `nixos-configs/framework-desktop/flake.nix`).
 *
 * The subdir is ATTESTER-CONTROLLED. A TRUSTED, Vega-operated reproducer later
 * builds `github:<owner>/<repo>/<rev>?dir=<sub>#<attr>` and byte-compares the
 * result to gate the master signing key, so an unsanitized value could steer the
 * trusted reproducer outside the pinned repo tree, or inject extra flake-ref
 * query/fragment parameters, or pass nix something that parses as a flag.
 *
 * Accepts ONLY a relative subpath inside the repository: a `/`-joined sequence of
 * segments drawn from `[A-Za-z0-9._-]`, with no `.` or `..` component, no leading
 * or trailing slash, and a length cap. Everything else (absolute paths, `..`,
 * `%`, `&`, `?`, `#`, whitespace, control characters, non-ASCII) is rejected, so
 * the value cannot break out of the `dir=` parameter. `%`-rejection also defeats
 * percent-encoded traversal (`%2e%2e`), since the charset has no `%`.
 *
 * This is the STRING-level control, enforced at the edge on ingest and never
 * trusting the client. It is NECESSARY BUT NOT SUFFICIENT on its own: a malicious
 * repository can commit a SYMLINK at a `dir` component pointing outside the
 * fetched tree, which this check cannot see. The reproducer therefore performs
 * the companion runtime control, rejecting a `dir` whose resolved path leaves the
 * fetched repository (or whose components are symlinks), before it builds.
 *
 * Returns the validated subdir, or null if it is not a safe relative subpath.
 */
const FLAKE_DIR = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const MAX_FLAKE_DIR_LEN = 255;

export function sanitizeFlakeDir(dir: unknown): string | null {
  if (typeof dir !== "string") return null;
  if (dir.length === 0 || dir.length > MAX_FLAKE_DIR_LEN) return null;
  if (!FLAKE_DIR.test(dir)) return null;
  // The charset permits `.` and `..` as whole segments; reject them explicitly so
  // a sanitized dir cannot traverse out of the repository tree.
  for (const seg of dir.split("/")) {
    if (seg === "." || seg === "..") return null;
  }
  return dir;
}

/**
 * Sanitize the flake output attribute (`#<attr>`) carried in a build's
 * provenance, e.g. `packages.x86_64-linux.hello`. Like the subdir it is
 * ATTESTER-CONTROLLED and the TRUSTED reproducer later builds
 * `github:<owner>/<repo>/<rev>?dir=<sub>#<attr>`.
 *
 * The value cannot break the revision pin or inject a nix flag on its own (the
 * rev pins before the fragment, everything after the first `#` is the attrpath,
 * and every nix invocation uses a `--` terminator). This string-level control is
 * defense in depth: it keeps a stored or forwarded attr from carrying a second
 * `#`/`?`/`&` fragment or query, whitespace, a shell metacharacter or a
 * non-ASCII byte.
 *
 * Accepts a flake attribute path: `.`-separated segments of `[A-Za-z0-9_+-]`,
 * with an optional trailing `^` output selector (`^*` or a comma-separated list
 * of output names) and a length cap. Everything else is rejected. Returns the
 * validated attr, or null if it is not a safe attribute path.
 */
const FLAKE_ATTR = /^[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*(?:\^(?:\*|[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*))?$/;
const MAX_FLAKE_ATTR_LEN = 255;

export function sanitizeFlakeAttr(attr: unknown): string | null {
  if (typeof attr !== "string") return null;
  if (attr.length === 0 || attr.length > MAX_FLAKE_ATTR_LEN) return null;
  if (!FLAKE_ATTR.test(attr)) return null;
  return attr;
}
