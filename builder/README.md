# Vega builder image

A reproducible OCI image that runs as a GitHub Actions self-hosted runner
(persistent by default) for your own repository, so heavy builds run on your
hardware instead of a free, preemptible GitHub-hosted runner. Design:
`garnix-ci/docs/builder-fleet.md`. User-facing guide:
https://docs.vega-cache.dev/heavy-builds.

This is Phase 1 (runner mode).

## Pull from GHCR

The image is published per release for `x86_64-linux` and `aarch64-linux` as a
manifest list, each architecture built natively and signed with cosign (keyless,
via the release workflow's OIDC identity) along with the list itself, so
`docker pull` selects the right image on x86 and ARM hosts alike. Pull it,
resolve it to an immutable digest, verify that digest, and run the digest, so
what you run is exactly what you verified (a tag like `:latest` can move
between verify and run):

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
  repos/<owner>/<repo>/actions/runners/registration-token --jq .token \
  > "$TOKEN_FILE"
chmod 0400 "$TOKEN_FILE"

cid=$(docker create --restart=unless-stopped --name vega-runner \
  --memory=12g --memory-swap=12g --cpus=4 \
  -e VEGA_MODE=runner \
  -e GITHUB_OWNER=<owner> \
  -e GITHUB_REPOSITORY=<repo> \
  -e GITHUB_RUNNER_TOKEN_FILE=/home/runner/.runner-token \
  -e GITHUB_RUNNER_LABELS=self-hosted,vega-<host> \
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
  a fresh layer and re-registers. With the supervisor-minted
  `GITHUB_RUNNER_TOKEN` flow that means minting a fresh token for the recreate;
  with the `GITHUB_PAT` fallback the entrypoint mints its own token and
  re-registers unattended ("Successfully replaced the runner"), so no manual
  token step is needed. Set a stable, unique `GITHUB_RUNNER_NAME` (defaults to
  `vega-<repo>`); on a recreate `--replace` reclaims the same-named registration
  so you do not accumulate stale offline runners. Remove a runner explicitly
  with `gh api --method DELETE repos/<o>/<r>/actions/runners/<id>`.
- **Recreating for an image update: carry only YOUR env across.** Pass the
  operator-set variables to the new container (`GITHUB_OWNER`,
  `GITHUB_REPOSITORY`, `GITHUB_RUNNER_NAME`, `GITHUB_RUNNER_LABELS`,
  `VEGA_MODE`, `VEGA_NIX_SANDBOX`, your token or PAT and any other `VEGA_`
  tuning you set) and let the new image supply its own `VEGA_BUILDER_ROOT`,
  `VEGA_NIX_REGINFO`, `RUNNER_DIST`, `PATH`, `HOME`, `USER`, `SSL_CERT_FILE`,
  `NIX_SSL_CERT_FILE` and `VEGA_BUILDER_VERSION`. Cloning the old container's
  whole environment pins those to the previous release: a stale
  `VEGA_BUILDER_ROOT` or `VEGA_NIX_REGINFO` roots and registers the OLD
  closure, which silently keeps the runner executing the old image's store
  paths after the upgrade.
- The Nix store persists across restarts in the container's own layer, so a
  long-lived runner does not re-fetch. Do **not** mount a named volume over
  `/nix` (`-v vega-nix:/nix`): the image bakes its toolchain into `/nix/store`,
  and a volume masks it with the volume's own (possibly older) contents. Docker
  seeds a named volume from the image only when the volume is empty, so a new
  image's store paths are never added to an existing volume, leaving the runner's
  baked entrypoint and tools as dangling symlinks. If you want a store that
  survives container *recreation*, either `docker volume rm` it on each image
  update or reseed it additively as described below; the safer default is no
  `/nix` volume, with `reuse-cache` substituting prior builds from your tenant.

  If you run with a `/nix` volume anyway: **image updates self-heal**. The
  image boots through a shim (`/bin/vega-bootstrap`, a real file on a static
  busybox, so it runs even when the volume masks the image's store). When the
  volume lacks this image's store paths (Docker only seeds an empty volume, so
  after an update the old store masks the new image's `/nix` and the
  entrypoint symlink dangles), the shim seeds the baked store copy
  (`/nix-seed/store`, shipped outside `/nix` precisely so the volume cannot
  mask it) into the volume additively, never overwriting existing paths, the
  database or gcroots, and then hands off. The entrypoint re-registers the
  baked closure in the Nix database on every boot (`nix-store --load-db`), so
  the seeded paths become valid, GC-safe store paths. The seed roughly doubles
  the image; the fast path (no volume, or an already seeded one) never touches
  it.

  Upgrading a volume deployment from an image OLDER than the shim (v0.14.0 or
  earlier as the NEW image) still needs the manual additive seed before the
  first start:

  ```
  docker run --rm --entrypoint /bin/sh -v <nix-volume>:/vol "$DIGEST" \
    -c 'cp -an /nix/store/. /vol/store/'
  ```

  Only `/nix/store` needs seeding: the image ships no `/nix/var` (the
  entrypoint creates the Nix state and loads the closure registration itself),
  so the next boot registers the seeded paths in the database. The boot
  preflight then verifies the runner's own closure is present and registered
  and refuses to start otherwise: a runner with a broken runtime would
  otherwise stay registered and keep accepting jobs it cannot execute, failing
  each one at GitHub's ten-minute no-communication timeout, which is worse than
  being offline (queued jobs fail instead of waiting). The periodic GC has the
  same backstop: if the runner's runtime ever disappears from the store, the
  container stops instead of limping.
- A persistent runner garbage-collects its store on a schedule so `/nix` does not
  grow without bound (it otherwise accumulates every path it ever built or
  substituted). The entrypoint runs `nix-collect-garbage --delete-older-than 7d`
  in the background; it takes the store GC lock and honors in-flight build
  temproots, so it never removes a path a running build needs. Tune with
  `VEGA_GC=false` (disable), `VEGA_GC_DELETE_OLDER_THAN` (default `7d`),
  `VEGA_GC_INTERVAL` (default `7d`) and `VEGA_GC_INITIAL_DELAY` (default `1h`).
  An ephemeral runner skips it (its store is fresh per job).
- **The store has a free-space floor, enforced during a build.** A periodic GC
  runs between builds, so it cannot help when one build produces more garbage
  than the disk has headroom: the build fills the disk first, and on a shared
  host the casualty is the whole machine rather than the build. Nix collects on
  its own whenever free space drops below `min-free`, until `max-free` is free,
  which is the only mechanism that acts mid-build. The entrypoint writes both
  into the generated `nix.conf` and prints them at boot.

  The defaults are a fraction of the store's filesystem (10% and 25%), floored
  at 1 GiB and capped at 25 GiB and 60 GiB, because a fixed size is wrong at both
  ends: 25 GiB on a 20 GB runner would sit permanently under the threshold and
  collect on every check, while 1 GiB on a large shared host is a rounding error
  against one build cycle. Override with `VEGA_MIN_FREE` and `VEGA_MAX_FREE`,
  which accept a byte count or a binary suffix (`VEGA_MIN_FREE=25G`).
  `VEGA_MIN_FREE=0` disables the floor, and the boot line says so.

  These are written into the `nix.conf` the entrypoint generates. If you mount
  your own `/etc/nix/nix.conf`, it is yours and the entrypoint does not edit it,
  so set `min-free` and `max-free` there; the boot warns when a mounted config
  leaves them unset.
- Nix's build sandbox is **auto-detected** (`VEGA_NIX_SANDBOX`, default `auto`).
  At startup the entrypoint builds a throwaway derivation under the real sandbox
  to learn whether this container can create the user namespace the sandbox
  needs. Docker blocks that unless the container is launched with userns allowed
  (`--privileged`, or `--security-opt seccomp=unconfined --security-opt
  apparmor=unconfined`). The modes:
  - `auto` (default): use `sandbox = true` when the probe succeeds, else fall
    back to `sandbox = relaxed` with a warning.
  - `true`: require the sandbox. If the probe fails the container exits rather
    than silently building unsandboxed. Use this for a TRUSTED own-repo runner
    you have launched with userns allowed.
  - `false`: opt out (no probe).

  A full sandbox is required for any package that sets a setuid bit while
  unpacking (e.g. `google-chrome`'s `chrome-sandbox`), which fails with
  "Operation not permitted" without it. Never use `--privileged` for the
  untrusted donate fleet; that tier needs microVM isolation instead. An
  operator-mounted `/etc/nix/nix.conf` is not rewritten (no probe); with
  `VEGA_NIX_SANDBOX=true` the contract still holds, so the container exits if
  the mounted config's effective `sandbox` is not `true`.
- The generated `/etc/nix/nix.conf` substitutes from `https://cache.nixos.org`
  and `https://vega-cache.dev` (with both public keys trusted), so the runner
  can reuse outputs it previously published to Vega instead of rebuilding them.
  To pull from additional caches (an upstream cache, your repo's cachix cache),
  pass `-e VEGA_EXTRA_SUBSTITUTERS=...` and
  `-e VEGA_EXTRA_TRUSTED_PUBLIC_KEYS=...` (space-separated lists). Example for
  a repo with its own cachix cache:

  ```
  -e VEGA_EXTRA_SUBSTITUTERS=https://<your-cache>.cachix.org \
  -e VEGA_EXTRA_TRUSTED_PUBLIC_KEYS=<your-cache>.cachix.org-1:<public key> \
  ```

  Extra entries only ever add substitution sources: a key admits only paths
  signed by it, so an unavailable or wrong cache is a miss, not a trust change.
- The bundled runner has auto-update disabled (`--disableupdate`); rebuild and
  re-pull the image to update the runner version.

## Point the workflow at it

In your repo's workflow, change the job (or its matrix entry) from
`runs-on: ubuntu-latest` to `runs-on: [self-hosted, vega-<host>]` so the label
set matches `GITHUB_RUNNER_LABELS`. Keep the workflow push-only: never let a
public fork PR target a self-hosted runner.

## What to watch (likely failure order)

1. `config.sh` / `run.sh` not found: confirm `RUNNER_DIST` points at the image's
   `github-runner` and the wrappers are under `bin/`.
2. Runner refuses to run as root without `RUNNER_ALLOW_RUNASROOT=1` (the entrypoint
   sets it).
3. `nix build` fails on missing state: the entrypoint runs `nix-store --init`,
   loads the baked closure registration on every boot (`nix-store --load-db`
   from `VEGA_NIX_REGINFO`, so a sandboxed build can mount each input's full
   closure and the baked paths are valid, GC-safe store paths) and writes
   `/etc/nix/nix.conf`.
4. node24: every action in the workflow must be node24-capable
   (`actions/checkout@v5+`, etc.); a node20-only action fails on this runner.
5. Sandbox setup errors: the entrypoint auto-detects this and falls back to
   `sandbox = relaxed` (or exits if you set `VEGA_NIX_SANDBOX=true`). For a full
   sandbox, launch with userns allowed: `--privileged`, or `--security-opt
   seccomp=unconfined --security-opt apparmor=unconfined`.
