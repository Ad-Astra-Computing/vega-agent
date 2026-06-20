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

# Build a throwaway derivation under the real sandbox to learn whether THIS
# container can actually create one. Docker blocks the sandbox's user/mount
# namespace setup unless it is launched with userns allowed (--privileged, or
# --security-opt seccomp=unconfined --security-opt apparmor=unconfined). The
# image ships no `unshare`, so we probe the only authoritative way: ask Nix to
# do exactly what a real build would. The builder is the image's own store-path
# bash, so the probe's closure is tiny and already present (no substitution).
#
# `sandbox-fallback false` is essential: with Nix's default fallback, a build
# that CANNOT be sandboxed silently runs unsandboxed and succeeds, so the probe
# would pass without real isolation. With fallback off, a sandbox that cannot
# start makes the build fail, which is exactly the signal we classify.
#
# Returns: 0 sandbox works; 10 sandbox/userns specifically unavailable; 1 the
# probe failed for an UNRELATED reason (a broken Nix, no network, ...), which the
# caller must surface rather than misread as "no sandbox".
probe_sandbox() {
  local bash_path bash_root log
  bash_path="$(readlink -f "$(command -v bash)")" || return 1
  # The top-level store path of the builder, e.g.
  # /nix/store/<hash>-bash-interactive-5.3p9. `builtins.storePath` needs this root
  # (not the /bin/bash subpath) and attaches dependency context, so Nix mounts the
  # builder's FULL closure (glibc, ...) into the sandbox. A context-free string
  # (a plain --argstr path) mounts only the bash binary, and the sandboxed build
  # then fails to find its interpreter: "bash: No such file or directory". This is
  # why the closure registration (init_store) alone was not enough.
  bash_root="/nix/store/$(printf '%s' "${bash_path#/nix/store/}" | cut -d/ -f1)"
  log="$(mktemp)"
  # SC2016: `$out` is a Nix build-time variable, deliberately passed literally to
  # Nix (it must NOT expand in this shell).
  # shellcheck disable=SC2016
  if nix-build --no-out-link \
       --option sandbox true \
       --option sandbox-fallback false \
       --option max-jobs 1 \
       --option build-users-group '' \
       --argstr bashRoot "$bash_root" \
       -E '{ bashRoot }: derivation {
             name = "vega-build-probe";
             system = builtins.currentSystem;
             builder = "${builtins.storePath bashRoot}/bin/bash";
             args = [ "-c" "echo ok > $out" ];
           }' \
       >"$log" 2>&1; then
    rm -f "$log"
    return 0
  fi
  # Failed. Show why, then classify. Match only signals SPECIFIC to sandbox setup
  # (Nix reports it under "setting up the build environment", and the cause is a
  # namespace/unshare/clone/seccomp/apparmor error). Generic "operation not permitted"
  # / "permission denied" are deliberately NOT matched: an unrelated Nix failure
  # must be treated as unexpected (return 1 -> fatal), never silently downgraded
  # to relaxed. The probe derivation is named to avoid self-matching the pattern.
  cat "$log" >&2
  if grep -Eqi 'setting up the build environment|namespace|unshare|CLONE_NEWUSER|cloning|clone\(|seccomp|apparmor' "$log"; then
    rm -f "$log"
    return 10
  fi
  rm -f "$log"
  return 1
}

# Resolve the effective `sandbox` setting from VEGA_NIX_SANDBOX (default `auto`)
# and echo it. `auto` probes and falls back to `relaxed` when no userns is
# available; `true` probes and hard-fails if the sandbox cannot start (so a
# build that the operator asked to isolate never runs unsandboxed by surprise);
# `false` is the explicit opt-out. An unrelated probe failure is always fatal.
resolve_sandbox() {
  local rc
  case "${VEGA_NIX_SANDBOX:-auto}" in
    false)
      echo false
      ;;
    true)
      rc=0; probe_sandbox || rc=$?
      if [ "$rc" -eq 0 ]; then echo true; return 0; fi
      if [ "$rc" -eq 10 ]; then
        echo "vega-builder: VEGA_NIX_SANDBOX=true but the Nix sandbox cannot start in this container. Launch with userns allowed: --privileged, or --security-opt seccomp=unconfined --security-opt apparmor=unconfined." >&2
      else
        echo "vega-builder: the Nix sandbox probe failed for an unexpected reason (see log above); refusing to start." >&2
      fi
      return 1
      ;;
    auto | *)
      rc=0; probe_sandbox || rc=$?
      if [ "$rc" -eq 0 ]; then echo true; return 0; fi
      if [ "$rc" -eq 10 ]; then
        echo "vega-builder: Nix sandbox unavailable (no userns in this container); using sandbox = relaxed. Launch with --privileged or seccomp/apparmor unconfined for full isolation, or set VEGA_NIX_SANDBOX=false to silence this." >&2
        echo relaxed
        return 0
      fi
      echo "vega-builder: the Nix sandbox probe failed for an unexpected reason (see log above); refusing to guess a sandbox mode." >&2
      return 1
      ;;
  esac
}

# Echo Nix's effective value for a config setting (the value Nix itself computes
# from the mounted nix.conf), or empty if it cannot be read.
effective_setting() {
  local name="$1" v
  v="$(nix --extra-experimental-features nix-command config show "$name" 2>/dev/null)" || true
  if [ -z "$v" ]; then
    v="$(nix --extra-experimental-features nix-command show-config 2>/dev/null | sed -n "s/^${name} = //p" | head -n1)" || true
  fi
  printf '%s' "$v"
}

# When VEGA_NIX_SANDBOX=true the sandbox is REQUIRED. With an operator-mounted
# nix.conf we do not rewrite the file, but we still hold the contract: refuse to
# start unless the build is GUARANTEED sandboxed, i.e. effective sandbox = true
# AND sandbox-fallback = false (otherwise a setup failure silently runs the build
# unsandboxed). Returns non-zero (caller exits) on a violation; no-op for
# auto/false.
enforce_required_sandbox() {
  [ "${VEGA_NIX_SANDBOX:-auto}" = true ] || return 0
  local eff_sb eff_fb
  eff_sb="$(effective_setting sandbox)"
  eff_fb="$(effective_setting sandbox-fallback)"
  [ "$eff_sb" = true ] && [ "$eff_fb" = false ] && return 0
  echo "vega-builder: VEGA_NIX_SANDBOX=true but the mounted /etc/nix/nix.conf has sandbox = ${eff_sb:-<unset>}, sandbox-fallback = ${eff_fb:-<unset>}. Set sandbox = true and sandbox-fallback = false there, or unset VEGA_NIX_SANDBOX to use auto-detection." >&2
  return 1
}

# Initialize the single-user store (no nixbld group) and register the baked
# closure. The registration (VEGA_NIX_REGINFO, baked into the image) records each
# store path's references, so a SANDBOXED build can mount each input's full
# closure; without it the sandboxed builder cannot find its interpreter (glibc)
# and fails with "No such file or directory". The marker is keyed by the
# registration's content hash, so a persisted /nix DB from an OLDER image (whose
# baked closure differs) is re-registered rather than skipped.
init_store() {
  [ -e /nix/var/nix/db/db.sqlite ] || NIX_CONFIG='build-users-group =' nix-store --init
  if [ -n "${VEGA_NIX_REGINFO:-}" ] && [ -e "${VEGA_NIX_REGINFO}" ]; then
    local sig marker
    sig="$(sha256sum "${VEGA_NIX_REGINFO}" | cut -c1-32)"
    marker="/nix/var/nix/db/.vega-registered-${sig}"
    if [ ! -e "$marker" ]; then
      NIX_CONFIG='build-users-group =' nix-store --load-db < "${VEGA_NIX_REGINFO}" \
        && : > "$marker"
    fi
  fi
}

# Minimal single-user Nix state for an ephemeral root container. The image ships
# the toolchain closure; a build fetches the rest from substituters. The sandbox
# mode is auto-detected (see resolve_sandbox): on by default when the container
# can create a user namespace, `relaxed` when it cannot.
setup_nix() {
  mkdir -p /nix/var/nix/db /nix/var/nix/gcroots /nix/var/nix/profiles \
           /nix/var/nix/temproots /nix/var/nix/userpool /etc/nix
  # Init + register the baked closure before any probe or build needs it.
  init_store
  # Respect an operator-mounted nix.conf: we do not rewrite it. We still enforce
  # the VEGA_NIX_SANDBOX=true contract (a `true` request must not run unsandboxed
  # because the mounted config disabled it).
  if [ -e /etc/nix/nix.conf ]; then
    enforce_required_sandbox || exit 1
    return 0
  fi

  local sandbox
  sandbox="$(resolve_sandbox)" || exit 1

  {
    echo "experimental-features = nix-command flakes"
    echo "sandbox = ${sandbox}"
    # When the sandbox is required (auto-detected as working, or forced), do NOT
    # let nix silently fall back to an unsandboxed build: a real isolation
    # failure must fail the build, not quietly weaken it. `relaxed`/`false`
    # already permit a non-isolated build, so the fallback is moot there.
    [ "${sandbox}" = true ] && echo "sandbox-fallback = false"
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
  echo "vega-builder: nix sandbox = ${sandbox}" >&2
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

main() {
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
}

# Run main only when executed, not when sourced (the test harness sources this
# file to exercise resolve_sandbox / probe_sandbox in isolation).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
