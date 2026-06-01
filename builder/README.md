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
  -e VEGA_MODE=runner \
  -e GITHUB_OWNER=jasonodoom \
  -e GITHUB_REPOSITORY=nixos-configs \
  -e GITHUB_RUNNER_TOKEN="$TOKEN" \
  -e GITHUB_RUNNER_LABELS=self-hosted,vega-perdurabo \
  -v vega-nix:/nix \
  vega-builder:0.2.0
```

For an unattended fleet, mint the token from a GitHub App installation token
(repository-scoped, `Administration: write`, expires in an hour) instead of `gh`.
As a trusted-local-only fallback you may pass `GITHUB_PAT` (fine-grained,
`Administration: write`) and let the container mint the token itself; it warns and
drops the PAT before the job. Prefer `GITHUB_RUNNER_TOKEN_FILE` (a `0400` tmpfs
file, removed once read) over the env var for either token.

Notes:
- `-v vega-nix:/nix` persists the Nix store across the ephemeral, one-job-per-run
  containers, so the toolchain and prior builds are not re-fetched every job.
- `--ephemeral` means one job then exit. Run it under a supervisor that restarts
  it (a `while true; do docker run ...; done` loop, or a systemd unit / nix-darwin
  service) so a fresh runner is always waiting.
- Nix's build sandbox is OFF by default because Docker blocks it without
  privilege. If a build needs host-like sandbox isolation, run with `--privileged`
  and `-e VEGA_NIX_SANDBOX=true`. Start without it; add it only if a build fails
  in sandbox setup.
- To pull heavy dependencies from a trusted upstream cache instead of building
  them, pass `-e VEGA_EXTRA_SUBSTITUTERS=...` and
  `-e VEGA_EXTRA_TRUSTED_PUBLIC_KEYS=...`.

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
