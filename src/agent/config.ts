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

  if (!Array.isArray(root.builds) || root.builds.length === 0) {
    throw new VegaConfigError("vega.yaml must list at least one build under `builds`");
  }
  const builds = root.builds.map((e, i) => parseBuild(e, i));

  const privacyRaw = root.privacy === undefined ? {} : asObject(root.privacy, "privacy");
  return {
    builds,
    reproduce: asBool(root.reproduce, "reproduce", false),
    privacy: {
      continent: asBool(privacyRaw.continent, "privacy.continent", true),
      pseudonym: asBool(privacyRaw.pseudonym, "privacy.pseudonym", false),
    },
  };
}
