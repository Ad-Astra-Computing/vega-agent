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
