/**
 * The Vega tenant cache a gh-actions build can substitute its OWN prior pushes
 * from. Registering this as a substituter before `nix build` means a cold runner
 * pulls paths this repo already pushed (e.g. the uncached nvim-treesitter query
 * derivations) from Vega instead of rebuilding them: build once, reuse forever.
 *
 * The tenant scope is the repository (`owner/repo`), matching where the
 * gh-actions lane publishes. The key endpoint returns the tenant verification
 * key (derived from the master, safe to publish) the runner must trust to accept
 * substitutes from this cache.
 */
export function tenantSubstituter(
  vegaUrl: string,
  repository: string,
): { url: string; keyUrl: string } {
  const base = vegaUrl.replace(/\/$/, "");
  return { url: `${base}/tenant/${repository}`, keyUrl: `${base}/tenant/${repository}/key` };
}

/**
 * The nix.conf lines a host needs to substitute this tenant's builds,
 * paste-ready.
 *
 * Exists because of a real deployment: a host substituted from the bare
 * control-plane URL for ten days. The root answers /nix-cache-info with 200
 * (it IS the shared-tier cache), so Nix accepted it, then missed every tenant
 * path with nothing to distinguish a misconfigured cache from a cold one, and
 * the host rebuilt its full closure on every run. The agent knows the right
 * lines the whole time; this puts them where someone configuring a host looks.
 */
export function hostConfigBlock(controlPlane: string, substituter: string, publicKey: string): string[] {
  const base = controlPlane.replace(/\/$/, "");
  const url = substituter.startsWith("http") ? substituter : `${base}${substituter}`;
  return [
    "To substitute these builds on a host, add to nix.conf (or your NixOS config):",
    `  extra-substituters = ${url}`,
    `  extra-trusted-public-keys = ${publicKey}`,
    `Note ${base} alone serves only the globally reproduced shared tier; these builds are served from the tenant path above.`,
  ];
}

/**
 * Is a Vega tenant key trusted while no substituter can actually serve its
 * paths? Returns a human-readable description of the mismatch, or null when
 * the configuration is coherent.
 *
 * A tenant key is any `vega-*` key that is neither the shared-tier key
 * (`vega-cache-1`) nor a per-consumer view key (`vega-view-*`). A tenant
 * key's paths are served under `/tenant/<owner>/<repo>` or via a `/u/<token>`
 * view, never by the bare control-plane URL, which is the shared tier.
 */
export function findSubstituterMismatch(
  substituters: string[],
  trustedKeys: string[],
  controlPlane: string,
): string | null {
  const base = controlPlane.replace(/\/$/, "");
  const tenantKeyNames = trustedKeys
    .map((k) => k.split(":")[0] ?? "")
    .filter((n) => n.startsWith("vega-") && n !== "vega-cache-1" && !n.startsWith("vega-view-"));
  if (tenantKeyNames.length === 0) return null;
  const norm = substituters.map((s) => s.replace(/\/$/, ""));
  if (norm.some((s) => s.startsWith(`${base}/tenant/`) || s.startsWith(`${base}/u/`))) return null;
  const names = tenantKeyNames.join(", ");
  return norm.includes(base)
    ? `${names} is trusted but the substituter is the bare ${base}, which serves only the shared tier; ` +
        `tenant builds are under ${base}/tenant/<owner>/<repo>`
    : `${names} is trusted but no ${base}/tenant/ substituter is configured`;
}
