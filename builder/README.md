# Vega builder image

A reproducible OCI image that runs as a GitHub Actions self-hosted runner
(persistent by default) for your own repository, so heavy builds run on your
hardware instead of a free, preemptible GitHub-hosted runner. Design:
`garnix-ci/docs/builder-fleet.md`. User-facing guide:
https://docs.vega-cache.dev/heavy-builds.

This is Phase 1 (runner mode).

## Pull from GHCR

The image is published per release and signed with cosign (keyless, via the
release workflow's OIDC identity). Pull it, resolve it to an immutable digest,
verify that digest, and run the digest, so what you run is exactly what you
verified (a tag like `:latest` can move between verify and run):

```
docker pull ghcr.io/ad-astra-computing/vega-builder:latest
DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' \
  ghcr.io/ad-astra-computing/vega-builder:latest)
cosign verify "$DIGEST" \
  --certificate-identity-regexp '^https://github\.com/Ad-Astra-Computing/vega-agent/\.github/workflows/publish-builder-image\.yml@refs/tags/[^/]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The identity regex pins the signer to this repo's publish workflow on a release
tag, so a signature minted by any other workflow, repo, or a branch build will
not verify. Keep `$DIGEST` for the run step below (same shell).

## Build from source

Alternatively, build it yourself on a Linux host (the image is Linux-only):

```
nix build github:Ad-Astra-Computing/vega-agent#builder-image
docker load < result
docker images | grep vega-builder    # vega-builder:<version>
```

## Run (runner mode)

The supervisor mints a short-lived registration token and hands it off so no
long-lived credential ever enters the container and no job can read it. Do not
pass it as an `-e` env var (visible via `docker inspect`) or as a lifetime bind
mount (stays readable inside the container for its whole life). Instead copy the
token into the container's own filesystem before starting it: the entrypoint
reads it and deletes it before the runner accepts any job. On your own machine,
mint it with `gh` (reuses your existing login, nothing to create):

```
TOKEN_FILE=$(mktemp)   # mktemp creates it mode 0600
gh api --method POST \
  repos/jasonodoom/nixos-configs/actions/runners/registration-token --jq .token \
  > "$TOKEN_FILE"
chmod 0400 "$TOKEN_FILE"

cid=$(docker create --restart=unless-stopped --name vega-runner \
  --memory=12g --memory-swap=12g --cpus=4 \
  -e VEGA_MODE=runner \
  -e GITHUB_OWNER=jasonodoom \
  -e GITHUB_REPOSITORY=nixos-configs \
  -e GITHUB_RUNNER_TOKEN_FILE=/home/runner/.runner-token \
  -e GITHUB_RUNNER_LABELS=self-hosted,vega-perdurabo \
  "$DIGEST")
docker cp "$TOKEN_FILE" "$cid:/home/runner/.runner-token"
rm -f "$TOKEN_FILE"   # host copy gone; the entrypoint deletes the in-container
docker start "$cid"   # copy after reading it, before run.sh accepts jobs
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
- **Restart vs recreate.** A plain restart (`--restart=unless-stopped`, a reboot,
  `docker restart`) reuses the saved registration in the container's writable
  layer and needs **no** new token, so it never crash-loops on the consumed
  one-shot token. Only *recreating* the container (e.g. updating the image) starts
  a fresh layer and re-registers, which needs a fresh token. Set a stable, unique
  `GITHUB_RUNNER_NAME` (defaults to `vega-<repo>`); on a recreate `--replace`
  reclaims the same-named registration so you do not accumulate stale offline
  runners. Remove a runner explicitly with `gh api --method DELETE
  repos/<o>/<r>/actions/runners/<id>`.
- The Nix store persists across restarts in the container's own layer, so a
  long-lived runner does not re-fetch. Do **not** mount a named volume over
  `/nix` (`-v vega-nix:/nix`): the image bakes its toolchain into `/nix/store`,
  and a volume masks it with the volume's own (possibly older) contents. Docker
  seeds a named volume from the image only when the volume is empty, so a new
  image's store paths are never added to an existing volume, leaving the runner's
  baked entrypoint and tools as dangling symlinks. If you want a store that
  survives container *recreation*, you must `docker volume rm` it whenever you
  update the image; the safer default is no `/nix` volume, with `reuse-cache`
  substituting prior builds from your tenant.
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
