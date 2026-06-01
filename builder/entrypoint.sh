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
  [ -e /nix/var/nix/db/db.sqlite ] || nix-store --init
  if [ ! -e /etc/nix/nix.conf ]; then
    {
      echo "experimental-features = nix-command flakes"
      echo "sandbox = ${VEGA_NIX_SANDBOX:-false}"
      echo "max-jobs = auto"
      # Single-user nix in the container: no nixbld build users / group.
      echo "build-users-group ="
      echo "substituters = https://cache.nixos.org ${VEGA_EXTRA_SUBSTITUTERS:-}"
      echo "trusted-public-keys = ${NIXOS_CACHE_KEY} ${VEGA_EXTRA_TRUSTED_PUBLIC_KEYS:-}"
    } > /etc/nix/nix.conf
  fi
}

run_runner() {
  : "${GITHUB_OWNER:?set GITHUB_OWNER}"
  : "${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY (name only, not owner/name)}"
  local pat; pat="$(read_secret GITHUB_PAT)"
  [ -n "$pat" ] || { echo "vega-builder: GITHUB_PAT (or GITHUB_PAT_FILE) is required to mint a runner token" >&2; exit 1; }

  local api="https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/actions/runners/registration-token"
  local token
  token="$(curl -fsSL -X POST \
    -H "Authorization: Bearer ${pat}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$api" | jq -er '.token')" || {
      echo "vega-builder: could not mint a registration token (check GITHUB_PAT scope: administration:write)" >&2; exit 1; }

  # Drop the long-lived credential before the runner (and any build) starts.
  unset GITHUB_PAT GITHUB_PAT_FILE pat

  setup_nix

  # The Nixpkgs github-runner ships wrappers in bin/ and keeps writable state
  # under RUNNER_ROOT, so we invoke those rather than the upstream tarball layout.
  export RUNNER_ROOT="${RUNNER_ROOT:-/home/runner/actions-runner}"
  export RUNNER_ALLOW_RUNASROOT=1
  mkdir -p "$RUNNER_ROOT"

  "$RUNNER_DIST/bin/config.sh" \
    --url "https://github.com/${GITHUB_OWNER}/${GITHUB_REPOSITORY}" \
    --token "$token" \
    --ephemeral --unattended --disableupdate \
    --name "${GITHUB_RUNNER_NAME:-vega-$(hostname)}" \
    --labels "${GITHUB_RUNNER_LABELS:-self-hosted,vega}" \
    --work "${RUNNER_ROOT}/_work"
  unset token

  # One job, then de-register (because of --ephemeral). The external supervisor
  # restarts the container for the next job.
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
