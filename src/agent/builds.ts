import type { VegaConfig } from "./config.js";

export interface ResolvedBuild {
  /** The flake installable to build, e.g. `/repo#packages.x86_64-linux.hello`. */
  installable: string;
  /** The attribute, recorded as provenance on the top-level output. */
  attr: string;
}

/**
 * The installables the agent builds. With a `vega.yaml`, one per declared build,
 * resolved against the repository's flake directory. Without one, the single CLI
 * installable (the existing behavior). Pure, so the CLI keeps file I/O and YAML
 * parsing and this stays testable.
 */
export function resolveBuilds(
  config: VegaConfig | null,
  fallbackInstallable: string,
  flakeDir: string,
): ResolvedBuild[] {
  if (config === null) {
    const i = fallbackInstallable.indexOf("#");
    return [{ installable: fallbackInstallable, attr: i >= 0 ? fallbackInstallable.slice(i + 1) : "" }];
  }
  const dir = flakeDir.replace(/\/+$/, "");
  return config.builds.map((b) => ({ installable: `${dir}#${b.attr}`, attr: b.attr }));
}
