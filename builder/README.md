# Vega builder image

A reproducible OCI image that runs as an ephemeral GitHub Actions self-hosted
runner for your own repository, so heavy builds run on your hardware instead of a
free, preemptible GitHub-hosted runner. Design: `garnix-ci/docs/builder-fleet.md`.

This is Phase 1 (runner mode). It is unvalidated until tested on a real host;
the steps below are that test. Do not publish the image until it passes.

## Build

On a Linux host (the image is Linux-only; build it on `perdurabo` itself):

```
nix build github:Ad-Astra-Computing/vega-agent#builder-image
docker load < result
docker images | grep vega-builder    # vega-builder:0.2.0
```

## Run (runner mode)

The supervisor mints a short-lived registration token and passes only that in, so
no long-lived credential ever enters the container. On your own machine, mint it
with `gh` (reuses your existing login, nothing to create):

```
TOKEN=$(gh api --method POST \
  repos/jasonodoom/nixos-configs/actions/runners/registration-token --jq .token)
docker run --rm \
  --memory=12g --memory-swap=12g --cpus=4 \
  -e VEGA_MODE=runner \
  -e GITHUB_OWNER=jasonodoom \
  -e GITHUB_REPOSITORY=nixos-configs \
  -e GITHUB_RUNNER_TOKEN="$TOKEN" \
  -e GITHUB_RUNNER_LABELS=self-hosted,vega-perdurabo \
  -v vega-nix:/nix \
  vega-builder:0.2.0
```

REQUIRED on a machine you use: cap the container with `--memory` (and
`--memory-swap` equal to it, so it cannot swap-thrash the host) and `--cpus`,
leaving real headroom. A large `nix build` will otherwise exhaust host RAM and
make the machine unresponsive. Tune to your hardware. The container additionally
limits `nix` parallelism (`max-jobs`, default 2; raise with `VEGA_NIX_MAX_JOBS` /
`VEGA_NIX_CORES` on a dedicated box), but the docker limits are the hard,
OS-enforced cap and must not be omitted.

For an unattended fleet, mint the token from a GitHub App installation token
(repository-scoped, `Administration: write`, expires in an hour) instead of `gh`.
As a trusted-local-only fallback you may pass `GITHUB_PAT` (fine-grained,
`Administration: write`) and let the container mint the token itself; it warns and
drops the PAT before the job. Prefer `GITHUB_RUNNER_TOKEN_FILE` (a `0400` tmpfs
file, removed once read) over the env var for either token.

Notes:
- The runner is **persistent** by default: one long-lived runner handles many
  jobs, so no supervisor or restart loop is needed (the simplest setup for your
  own host, and it does not assume systemd or Nix). Set `VEGA_RUNNER_EPHEMERAL=true`
  for one-job-then-exit (the model for the untrusted donate fleet, where a
  supervisor recreates the container per job).
- Set a stable, unique `GITHUB_RUNNER_NAME` (it defaults to `vega-<repo>`).
  `--replace` lets a restart reclaim the same-named registration, so you do not
  accumulate stale offline runners. Stopping the container leaves it registered
  offline until the next start reclaims it (or remove it with `gh api --method
  DELETE repos/<o>/<r>/actions/runners/<id>`).
- `-v vega-nix:/nix` persists the Nix store across restarts, so the toolchain and
  prior builds are not re-fetched. Reclaim space later with `nix store gc`.
- Nix's build sandbox is OFF by default because Docker blocks it without
  privilege. For a TRUSTED own-repo runner, run `--privileged` with
  `-e VEGA_NIX_SANDBOX=true` to get the real sandbox. This is required for any
  package that sets a setuid bit while unpacking (e.g. `google-chrome`'s
  `chrome-sandbox`), which fails with "Operation not permitted" under
  `sandbox=false`. Never use `--privileged` for the untrusted donate fleet; that
  tier needs microVM isolation instead.
- To pull heavy dependencies from a trusted upstream cache instead of building
  them, pass `-e VEGA_EXTRA_SUBSTITUTERS=...` and
  `-e VEGA_EXTRA_TRUSTED_PUBLIC_KEYS=...`.
- The bundled runner has auto-update disabled (`--disableupdate`); rebuild and
  re-pull the image to update the runner version.

## Point the workflow at it

In `nixos-configs/.github/workflows/vega-cache.yml`, change perdurabo's matrix
entry from `os: ubuntu-latest` to `runs-on: [self-hosted, vega-perdurabo]` (label
match). Keep the workflow push-only: never let a public fork PR target a
self-hosted runner.

## What to watch (likely failure order)

1. `config.sh` / `run.sh` not found: confirm `RUNNER_DIST` points at the image's
   `github-runner` and the wrappers are under `bin/`.
2. Runner refuses to run as root without `RUNNER_ALLOW_RUNASROOT=1` (the entrypoint
   sets it).
3. `nix build` fails on missing state: the entrypoint runs `nix-store --init` and
   writes `/etc/nix/nix.conf`; if a build still cannot find paths, the baked
   closure may need DB registration (`nix-store --load-db`).
4. node24: every action in the workflow must be node24-capable
   (`actions/checkout@v5+`, etc.); a node20-only action fails on this runner.
5. Sandbox setup errors: run `--privileged` with `VEGA_NIX_SANDBOX=true`.
