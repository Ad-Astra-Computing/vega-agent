/**
 * `vega.yaml` is the contributor config: it tells the agent which flake
 * attributes to build and attest, on which systems, and the privacy and
 * reproduction preferences. It configures what you contribute, not a CI service.
 *
 * This module is the pure, validated parser. The agent CLI reads and YAML-parses
 * the file, then hands the raw object here; keeping I/O out makes the schema
 * testable. A bare attribute name is shorthand for `{ attr: <name> }`.
 */

export interface VegaBuild {
  /** Flake attribute, e.g. `packages.x86_64-linux.hello` or a short name. */
  attr: string;
  /** Systems to build on; empty means "the runner's current system". */
  systems: string[];
}

export interface VegaConfig {
  builds: VegaBuild[];
  /** Request shared-tier reproduction for these outputs (default false). */
  reproduce: boolean;
  /**
   * Register Vega's own tenant cache as a substituter before building, so a cold
   * runner pulls this repo's prior pushes instead of rebuilding them (default
   * false). A build that substitutes from Vega is no longer independent of Vega,
   * so leave this OFF for jobs whose outputs feed shared-tier attestation.
   */
  reuseCache: boolean;
  /**
   * devShell names to build and cache (in addition to `builds`), e.g.
   * `[default, rust]`. The agent expands each to `devShells.<system>.<name>` for
   * the runner's system; building it caches the shell's full dependency closure,
   * so a contributor's `nix develop` substitutes instead of rebuilding.
   */
  devShells: string[];
  /**
   * Garnix-style attribute matchers (globs like `packages.x86_64-linux.*`,
   * `*.*`) selecting flake outputs to build, in addition to `builds`. Build
   * everything matching `include`, minus `exclude`; `exclude` is applied last to
   * the whole resolved set (explicit builds, devShells, and included outputs).
   */
  include: string[];
  exclude: string[];
  /**
   * Scan each build's own output for credentials (private keys, cloud/service
   * tokens) before uploading, and warn on a hit (default true). A path cached to
   * the public, content-addressed store cannot be unpublished, so this is the
   * last point a leaked secret can be caught. Set `secret-scan: false` to disable.
   */
  secretScan: boolean;
  privacy: {
    /** Publish the builder's continent (default true). */
    continent: boolean;
    /** Attest under a stable pseudonym instead of the GitHub handle (default false). */
    pseudonym: boolean;
  };
}

export class VegaConfigError extends Error {}

function asObject(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new VegaConfigError(`${where} must be a mapping`);
  }
  return v as Record<string, unknown>;
}

function asBool(v: unknown, where: string, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  if (typeof v !== "boolean") throw new VegaConfigError(`${where} must be a boolean`);
  return v;
}

function parseBuild(entry: unknown, i: number): VegaBuild {
  // Shorthand: a bare string is the attribute.
  if (typeof entry === "string") {
    if (entry === "") throw new VegaConfigError(`builds[${i}] attribute is empty`);
    return { attr: entry, systems: [] };
  }
  const o = asObject(entry, `builds[${i}]`);
  if (typeof o.attr !== "string" || o.attr === "") {
    throw new VegaConfigError(`builds[${i}].attr must be a non-empty string`);
  }
  let systems: string[] = [];
  if (o.systems !== undefined) {
    if (!Array.isArray(o.systems) || !o.systems.every((s) => typeof s === "string" && s !== "")) {
      throw new VegaConfigError(`builds[${i}].systems must be an array of system strings`);
    }
    systems = o.systems as string[];
  }
  return { attr: o.attr, systems };
}

/** Validate a parsed `vega.yaml` object into a {@link VegaConfig}. */
export function parseVegaConfig(raw: unknown): VegaConfig {
  const root = asObject(raw, "vega.yaml");

  if (root.builds !== undefined && !Array.isArray(root.builds)) {
    throw new VegaConfigError("vega.yaml `builds` must be a list");
  }
  const builds = (Array.isArray(root.builds) ? root.builds : []).map((e, i) => parseBuild(e, i));

  let devShells: string[] = [];
  if (root.devShells !== undefined) {
    if (
      !Array.isArray(root.devShells) ||
      !root.devShells.every((s) => typeof s === "string" && /^[a-zA-Z0-9._-]+$/.test(s))
    ) {
      throw new VegaConfigError("devShells must be an array of shell names ([A-Za-z0-9._-])");
    }
    devShells = root.devShells as string[];
  }

  const matchers = (raw: unknown, where: string): string[] => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || !raw.every((s) => typeof s === "string" && /^[a-zA-Z0-9._*-]+$/.test(s))) {
      throw new VegaConfigError(`${where} must be an array of attribute matchers ([A-Za-z0-9._*-])`);
    }
    return raw as string[];
  };
  const include = matchers(root.include, "include");
  const exclude = matchers(root.exclude, "exclude");

  if (builds.length === 0 && devShells.length === 0 && include.length === 0) {
    throw new VegaConfigError("vega.yaml must declare at least one of `builds`, `devShells`, or `include`");
  }

  const privacyRaw = root.privacy === undefined ? {} : asObject(root.privacy, "privacy");
  return {
    builds,
    reproduce: asBool(root.reproduce, "reproduce", false),
    reuseCache: asBool(root["reuse-cache"], "reuse-cache", false),
    devShells,
    include,
    exclude,
    secretScan: asBool(root["secret-scan"], "secret-scan", true),
    privacy: {
      continent: asBool(privacyRaw.continent, "privacy.continent", true),
      pseudonym: asBool(privacyRaw.pseudonym, "privacy.pseudonym", false),
    },
  };
}
