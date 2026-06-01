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
