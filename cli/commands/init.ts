import type { Command } from "commander";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pc from "picocolors";
import { success, info, fail, jsonEvent } from "../ui.js";

// The path the recipe is written to, and the default attribute it builds.
export const WORKFLOW_PATH = ".github/workflows/vega-cache.yml";
export const DEFAULT_ATTR = "packages.x86_64-linux.default";

// Pinned action commit SHAs (a moved tag is a supply-chain vector; a SHA is
// immutable). Bumped on each release in lockstep with examples/vega-cache.yml and
// the docs recipe; cli/commands/init.test.ts asserts the example file stays equal
// to renderWorkflow(DEFAULT_ATTR), so these cannot drift apart silently.
const CHECKOUT = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"; // v7.0.0
const AGENT = "Ad-Astra-Computing/vega-agent/agent@fc8e1ddd9d5ff16f245603368b06b675cad06783"; // v0.15.0

/**
 * The canonical CI recipe with the build attribute substituted. Pure: the caller
 * does the I/O. The `\${{ ... }}` are GitHub Actions expressions emitted literally
 * (escaped so the template literal does not interpolate them); `${attr}` is the
 * one real substitution.
 */
export function renderWorkflow(attr: string): string {
  return `# Build your flake in CI and publish its outputs to the Vega binary cache,
# attested over GitHub Actions OIDC (no stored secret). Docs: https://docs.vega-cache.dev
#
# Pin actions to commit SHAs, not tags: a moved tag is a supply-chain vector and a
# SHA is immutable. Enable Dependabot's github-actions ecosystem to bump them.
name: Cache with Vega

# Push and manual dispatch only, never pull_request: a fork PR can read the OIDC
# token, so the id-token permission must not exist on a run that builds untrusted
# PR code.
on:
  push:
    branches: [main]
  workflow_dispatch:

# Least privilege: read the repo to build it, and mint an OIDC token so Vega can
# verify the builder identity. Nothing else.
permissions:
  contents: read
  id-token: write

# One cache run per ref; do not cancel an in-flight push.
concurrency:
  group: vega-cache-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  cache:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: ${CHECKOUT} # v7.0.0
        with:
          persist-credentials: false # no git push; do not leave the token in .git/config
      - name: Build and publish to Vega
        # A per-step cap in addition to the job cap: a build or publish that
        # stalls then fails fast and legibly here, instead of idling against
        # GitHub's 6-hour default looking identical to a slow build.
        timeout-minutes: 45
        uses: ${AGENT} # v0.15.0
        with:
          # github.workspace is the checkout root, so the attestation's provenance
          # matches the repo and the output can be reproduced. Change the attribute
          # to whatever you want cached.
          installable: "\${{ github.workspace }}#${attr}"
          control-plane: https://vega-cache.dev
          skip-upstream: "true" # upload only paths cache.nixos.org does not already serve
          # If your closure has dependencies that no public cache serves (a
          # private or team Cachix, an overlay-built package), list those caches
          # here. Omitting them means nix builds such dependencies FROM SOURCE
          # on this 2-core hosted runner, which for a large package exhausts the
          # runner before it finishes ("The runner has received a shutdown
          # signal" or a lost-communication kill, often with no logs uploaded).
          # A trusted public key only admits paths signed by it, so listing a
          # cache is a substitution source, never a trust widening.
          # extra-substituters: "https://<your-cache>.cachix.org"
          # extra-trusted-public-keys: "<your-cache>.cachix.org-1:<public key>"

# Note for self-hosted builder operators (ghcr.io/ad-astra-computing/vega-builder):
# when you update the image, a persistent /nix volume self-heals from v0.15.0
# onward; a heal logs "seeding the baked store copy", and images newer than
# v0.15.0 also attest a healthy boot with "store complete, direct handoff".
# Upgrading TO v0.14.0 or older instead needs a manual additive seed first; see
# the builder README.
`;
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Scaffold a GitHub Actions workflow that caches this repo to Vega")
    .option("--attr <attr>", "flake attribute to build", DEFAULT_ATTR)
    .option("--dir <path>", "repository root to write into", ".")
    .option("--force", "overwrite an existing workflow file")
    .option("--print", "print the recipe to stdout instead of writing a file")
    .option("--json", "output JSON")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  vega init                                  # write .github/workflows/vega-cache.yml\n" +
        "  vega init --attr packages.x86_64-linux.foo\n" +
        "  vega init --print > vega-cache.yml\n",
    )
    .action((opts: { attr: string; dir: string; force?: boolean; print?: boolean; json?: boolean }) => {
      const content = renderWorkflow(opts.attr);

      if (opts.print) {
        process.stdout.write(content);
        return;
      }

      const target = resolve(opts.dir, WORKFLOW_PATH);
      if (existsSync(target) && !opts.force) {
        fail(`${WORKFLOW_PATH} already exists`, [
          `Re-run with ${pc.cyan("--force")} to overwrite, or ${pc.cyan("--print")} to see the recipe.`,
        ]);
      }

      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);

      if (opts.json) {
        jsonEvent({ written: target, attr: opts.attr });
        return;
      }

      success(`Wrote ${WORKFLOW_PATH}`);
      info(
        "\n  Next:\n" +
          `    1. Edit the ${pc.cyan("installable")} attribute if ${pc.cyan(opts.attr)} is not what you cache.\n` +
          `    2. Commit it on a branch and open a PR:\n` +
          `         ${pc.gray("git switch -c add-vega-cache && git add " + WORKFLOW_PATH)}\n` +
          `         ${pc.gray('git commit -m "ci: cache builds to Vega" && gh pr create --fill')}\n` +
          `    3. Install the Vega GitHub App for the commit check: ${pc.cyan("https://github.com/apps/vega-cache")}\n`,
      );
    });
}
