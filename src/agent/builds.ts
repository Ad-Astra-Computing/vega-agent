import { isAbsolute, relative, resolve } from "node:path";
import type { VegaConfig } from "./config.js";
import { matchOutputs, matchesAnyGlob } from "./outputs.js";

export interface ResolvedBuild {
  /** The flake installable to build, e.g. `/repo#packages.x86_64-linux.hello`. */
  installable: string;
  /** The attribute, recorded as provenance on the top-level output. */
  attr: string;
}

/**
 * The installables the agent builds. With a `vega.yaml`, one per declared build
 * plus one per declared devShell (resolved to `devShells.<system>.<name>` for
 * the runner's `currentSystem`), against the repository's flake directory.
 * Without a config, the single CLI installable (the existing behavior). Pure, so
 * the CLI keeps file I/O, YAML parsing, and system detection, and this stays
 * testable.
 */
export function resolveBuilds(
  config: VegaConfig | null,
  fallbackInstallable: string,
  flakeDir: string,
  currentSystem?: string,
  flakeOutputs?: string[],
): ResolvedBuild[] {
  if (config === null) {
    const i = fallbackInstallable.indexOf("#");
    return [{ installable: fallbackInstallable, attr: i >= 0 ? fallbackInstallable.slice(i + 1) : "" }];
  }
  const dir = flakeDir.replace(/\/+$/, "");

  // Collect candidate attrs: explicit builds, devShells, then include matches.
  const attrs: string[] = config.builds.map((b) => b.attr);
  if (config.devShells.length > 0) {
    if (!currentSystem) throw new Error("resolveBuilds: currentSystem is required to expand devShells");
    attrs.push(...config.devShells.map((name) => `devShells.${currentSystem}.${name}`));
  }
  if (config.include.length > 0) {
    if (flakeOutputs === undefined) {
      throw new Error("resolveBuilds: flakeOutputs is required to expand include matchers");
    }
    attrs.push(...matchOutputs(flakeOutputs, config.include, []));
  }

  // `exclude` is applied last, to the whole set; dedupe preserving order.
  const seen = new Set<string>();
  const out: ResolvedBuild[] = [];
  for (const attr of attrs) {
    if (seen.has(attr) || matchesAnyGlob(attr, config.exclude)) continue;
    seen.add(attr);
    out.push({ installable: `${dir}#${attr}`, attr });
  }
  return out;
}

/**
 * Whether an installable's flake refers to the running repository's own flake.
 * Vega records gh-actions provenance from the OIDC repo (`github:<repository>`),
 * so an attestation is only reproducible if what was built IS that repo's flake.
 * Local checkouts (`.#`, an absolute path, the flake dir) and an explicit
 * `github:<repository>` reference qualify; a foreign flake (e.g. nixpkgs or
 * another repo) does not, and the recorded candidate would be unbuildable.
 */
export function installableTargetsOwnRepo(
  installable: string,
  flakeDir: string,
  repository: string | undefined,
): boolean {
  return ownRepoSubflakeDir(installable, flakeDir, repository) !== null;
}

/**
 * Classify an installable's flake against the running repository, returning the
 * SUBFLAKE DIRECTORY (relative to the repo root) that Vega should record so the
 * build is reproducible:
 *   - `""`        the repository's own ROOT flake (the CLI default `.#`, the
 *                 checkout path, or an explicit `github:<repository>`).
 *   - `"<sub>"`   a subdirectory flake WITHIN the checkout (`<flakeDir>/<sub>#…`)
 *                 or an explicit `github:<repository>?dir=<sub>`. Vega reproduces
 *                 it as `github:<repository>/<rev>?dir=<sub>` (see the edge).
 *   - `null`      a FOREIGN flake (another repo, nixpkgs, or a path outside the
 *                 checkout): Vega still records `github:<repository>#attr`, which
 *                 it cannot reproduce, so the caller warns and it stays tenant tier.
 * The returned subdir is the raw relative path; the edge sanitizes it on ingest.
 */
export function ownRepoSubflakeDir(
  installable: string,
  flakeDir: string,
  repository: string | undefined,
): string | null {
  const ref = (installable.split("#")[0] ?? "").replace(/\/+$/, "");
  const dir = flakeDir.replace(/\/+$/, "");
  // An explicit `github:<owner>/<repo>` ref: own repo (optionally a `?dir=`
  // subflake) or a foreign repo. A foreign owner/repo never yields a dir.
  const gm = /^github:([^/?#]+\/[^/?#]+)(?:[/?#]|$)/.exec(ref);
  if (gm) {
    if (repository === undefined || gm[1]!.toLowerCase() !== repository.toLowerCase()) return null;
    const dm = /[?&]dir=([^&#]*)/.exec(ref);
    if (dm === null) return "";
    try {
      return decodeURIComponent(dm[1]!);
    } catch {
      return null; // a malformed %-escape is not a usable subdir
    }
  }
  // A LOCAL path ref (`.`, absolute, `./`/`../` relative, or `path:`-prefixed):
  // resolve it against the checkout root and accept it only if it stays inside.
  const isLocalPath =
    ref === "" || ref === "." || ref.startsWith("/") || ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("path:");
  if (isLocalPath) {
    const local = ref.replace(/^path:/, "");
    if (local === "" || local === ".") return "";
    const rel = relative(dir, resolve(dir, local));
    if (rel === "") return ""; // the checkout root itself
    // `..` or `../…` traversal, or an absolute result, escapes the checkout. (A
    // real in-repo child like `..foo` is NOT a traversal segment, so allow it.)
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
    return rel;
  }
  // Any other flake ref (a different remote: git+https, gitlab:, a tarball, ...)
  // is recorded as `github:<repository>` and so is unreproducible.
  return null;
}
