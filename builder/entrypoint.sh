#!/usr/bin/env bash
# Entrypoint for the Vega builder image. Two modes (see docs/builder-fleet.md):
#   VEGA_MODE=runner  registers an EPHEMERAL GitHub Actions self-hosted runner
#                     for the owner's OWN repo, runs one job, exits. An external
#                     loop (systemd, `while true`) restarts the container for the
#                     next job. Trusted code: plain Docker is acceptable.
#   VEGA_MODE=donate  (Phase 2) a Vega-queue reproduction worker. Not yet here.
#
# The runner needs a registration token. We mint a short-lived one from a PAT (or
# GitHub App) here in the supervisor, then DROP the long-lived credential from the
# environment before handing control to the runner, so a build job cannot read it.
set -euo pipefail

VERSION="${VEGA_BUILDER_VERSION:-dev}"
NIXOS_CACHE_KEY="cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="

banner() {
  # On a TTY only, and never when VEGA_NO_BANNER is set, so machine-readable
  # logs stay clean.
  [ -t 1 ] || return 0
  [ -n "${VEGA_NO_BANNER:-}" ] && return 0
  local cyan reset
  cyan=$'\033[38;5;111m'; reset=$'\033[0m'
  printf '%s' "$cyan"
  cat <<'STAR'
          *
        \ | /
     --  VEGA  --
        / | \
          *
STAR
  printf '%s' "$reset"
  printf '  Vega builder %s   mode=%s\n' "$VERSION" "${VEGA_MODE:-runner}"
  printf '  https://vega-cache.dev   |   docs.vega-cache.dev\n\n'
}

# Read a secret from FILE-valued env first (docker/k8s secrets), else the plain
# env var. Echoes the value; caller captures and the plain var is unset after.
read_secret() {
  local name="$1" file_var="${1}_FILE"
  if [ -n "${!file_var:-}" ]; then cat "${!file_var}"; return 0; fi
  printf '%s' "${!name:-}"
}

# Minimal single-user Nix state for an ephemeral root container. The image ships
# the toolchain closure; a build fetches the rest from substituters. The sandbox
# is OFF by default because Docker blocks the sandbox's mount/clone unless the
# container runs --privileged; set VEGA_NIX_SANDBOX=true when you do run it
# privileged for host-like build isolation.
setup_nix() {
  mkdir -p /nix/var/nix/db /nix/var/nix/gcroots /nix/var/nix/profiles \
           /nix/var/nix/temproots /nix/var/nix/userpool /etc/nix
  # Write nix.conf BEFORE any nix command so single-user settings (no nixbld
  # group) apply to `nix-store --init` too, not just later builds.
  if [ ! -e /etc/nix/nix.conf ]; then
    {
      echo "experimental-features = nix-command flakes"
      echo "sandbox = ${VEGA_NIX_SANDBOX:-false}"
      # Bound build parallelism so a build cannot peg a shared host. The HARD cap
      # is the docker --memory/--cpus on `docker run` (see README) which the OS
      # enforces; these are the softer nix-level limits. Default conservatively
      # (2 parallel jobs) and raise VEGA_NIX_MAX_JOBS / VEGA_NIX_CORES on a
      # dedicated machine.
      echo "max-jobs = ${VEGA_NIX_MAX_JOBS:-2}"
      echo "cores = ${VEGA_NIX_CORES:-0}"
      # Single-user nix in the container: no nixbld build users / group.
      echo "build-users-group ="
      echo "substituters = https://cache.nixos.org ${VEGA_EXTRA_SUBSTITUTERS:-}"
      echo "trusted-public-keys = ${NIXOS_CACHE_KEY} ${VEGA_EXTRA_TRUSTED_PUBLIC_KEYS:-}"
    } > /etc/nix/nix.conf
  fi
  [ -e /nix/var/nix/db/db.sqlite ] || nix-store --init
}

run_runner() {
  : "${GITHUB_OWNER:?set GITHUB_OWNER}"
  : "${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY (name only, not owner/name)}"

  setup_nix

  # The Nixpkgs github-runner ships wrappers in bin/ and keeps writable state
  # under RUNNER_ROOT, so we invoke those rather than the upstream tarball layout.
  export RUNNER_ROOT="${RUNNER_ROOT:-/home/runner/actions-runner}"
  export RUNNER_ALLOW_RUNASROOT=1
  mkdir -p "$RUNNER_ROOT"

  # Configure only when there is no saved registration. On a plain container
  # restart (docker restart / --restart policy) the writable layer persists, so
  # the existing registration is reused and NO token is needed or expected (a
  # one-shot token was consumed at first start). A recreated container (fresh
  # layer, e.g. an image update) has no saved registration and is configured
  # again from a fresh token. This is what makes --restart=unless-stopped safe:
  # a restart does not re-run registration and so cannot crash-loop on a missing
  # token.
  if [ ! -f "$RUNNER_ROOT/.runner" ]; then
    # PRIMARY path: a short-lived registration token minted by the SUPERVISOR
    # (gh on your own machine, or a GitHub App for a fleet) and passed in, so no
    # long-lived credential ever enters this container. Prefer
    # GITHUB_RUNNER_TOKEN_FILE (a tmpfs/copied-in secret file) over the env var.
    local token; token="$(read_secret GITHUB_RUNNER_TOKEN)"
    # The token value (if any) is now captured in $token. Drop the env var and
    # any file it came from immediately, before any branch, so neither the PAT
    # fallback nor run.sh can ever see a leftover registration credential, even
    # when the file was set but empty. The rm is best-effort: a read-only secret
    # mount cannot be unlinked from inside the container, and that must not abort
    # the runner (the env var is still cleared, and a read-only mount's lifecycle
    # is the orchestrator's, not ours).
    if [ -n "${GITHUB_RUNNER_TOKEN_FILE:-}" ]; then rm -f "$GITHUB_RUNNER_TOKEN_FILE" 2>/dev/null || true; fi
    unset GITHUB_RUNNER_TOKEN GITHUB_RUNNER_TOKEN_FILE
    if [ -z "$token" ]; then
      # FALLBACK (trusted local runner only): mint inside the container from a PAT.
      # Weaker, because a broad credential briefly enters the container; never use
      # it for anything but your own trusted runner.
      local pat; pat="$(read_secret GITHUB_PAT)"
      # Remove the file-backed PAT as soon as it is read, before any exit path, so
      # a file-mounted credential never outlives this step into the job (the runner
      # runs as root). Best-effort, same as the runner-token file above.
      if [ -n "${GITHUB_PAT_FILE:-}" ]; then rm -f "$GITHUB_PAT_FILE" 2>/dev/null || true; fi
      [ -n "$pat" ] || {
        echo "vega-builder: pass GITHUB_RUNNER_TOKEN (preferred: mint it in your supervisor with gh or a GitHub App) or, for a trusted local runner only, GITHUB_PAT" >&2
        exit 1
      }
      echo "vega-builder: minting a registration token from GITHUB_PAT inside the container (trusted-local fallback; prefer a supervisor-minted GITHUB_RUNNER_TOKEN)" >&2
      local api="https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/actions/runners/registration-token"
      token="$(curl -fsSL -X POST \
        -H "Authorization: Bearer ${pat}" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "$api" | jq -er '.token')" || {
          echo "vega-builder: could not mint a registration token (check GITHUB_PAT scope: administration:write)" >&2; exit 1; }
      unset GITHUB_PAT GITHUB_PAT_FILE pat
    fi

    # Persistent by default: one long-lived runner handles many jobs. Set
    # VEGA_RUNNER_EPHEMERAL=true for one-job-then-exit (the untrusted donate fleet,
    # where a supervisor recreates the container per job). --replace lets a
    # re-registration reclaim the same-named registration, so a STABLE name (not
    # the random container hostname) avoids piling up stale offline runners.
    # Default to a per-repo name; set GITHUB_RUNNER_NAME explicitly, and uniquely,
    # if you run more than one.
    local cfg_args=(--unattended --disableupdate --replace)
    [ "${VEGA_RUNNER_EPHEMERAL:-false}" = "true" ] && cfg_args+=(--ephemeral)

    "$RUNNER_DIST/bin/config.sh" \
      --url "https://github.com/${GITHUB_OWNER}/${GITHUB_REPOSITORY}" \
      --token "$token" \
      "${cfg_args[@]}" \
      --name "${GITHUB_RUNNER_NAME:-vega-${GITHUB_REPOSITORY}}" \
      --labels "${GITHUB_RUNNER_LABELS:-self-hosted,vega}" \
      --work "${RUNNER_ROOT}/_work"
    unset token
  fi

  exec "$RUNNER_DIST/bin/run.sh"
}

banner
case "${VEGA_MODE:-runner}" in
  runner) run_runner ;;
  donate)
    echo "vega-builder: donate mode is Phase 2 and not implemented yet" >&2
    exit 64
    ;;
  *)
    echo "vega-builder: VEGA_MODE must be 'runner' or 'donate' (got '${VEGA_MODE:-}')" >&2
    exit 64
    ;;
esac
