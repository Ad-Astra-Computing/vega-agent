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
# The Vega cache itself is a default substituter: a builder that publishes to
# Vega should also substitute from it, or the box that builds our own closures
# recompiles its own prior outputs from source. trusted-public-keys only admits
# paths signed by the key, so a cache miss is a miss, never a trust widening.
# Deployment-specific caches (e.g. a repo's cachix cache) belong in
# VEGA_EXTRA_SUBSTITUTERS / VEGA_EXTRA_TRUSTED_PUBLIC_KEYS, not baked here.
VEGA_CACHE_URL="https://vega-cache.dev"
VEGA_CACHE_PUBKEY="vega-cache-1:cPagS1g69NQGwlBCyTTeKav/NhlN8a7ixuj2uLOkHrQ="
# Nix state lives here. A plain variable (not an env knob): the test harness
# reassigns it after sourcing, and an environment override would desync the
# script's gcroots and db checks from the state directory Nix actually uses.
NIX_STATE="/nix/var/nix"

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
  local bash_rel
  bash_root="/nix/store/$(printf '%s' "${bash_path#/nix/store/}" | cut -d/ -f1)"
  bash_rel="${bash_path#"$bash_root"/}"  # the builder's path under the store root, e.g. bin/bash
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
       --argstr bashRel "$bash_rel" \
       -E '{ bashRoot, bashRel }: derivation {
             name = "vega-build-probe";
             system = builtins.currentSystem;
             builder = "${builtins.storePath bashRoot}/${bashRel}";
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
# and fails with "No such file or directory".
#
# The load runs on EVERY boot, unconditionally. An earlier version skipped it
# behind a marker file keyed by the registration's content hash, which broke the
# persistent-/nix-volume recovery path: after a GC deleted the baked paths,
# copying them back out of the image restored the FILES but not their database
# entries, and the surviving marker meant the entries were never re-created. An
# unregistered path is not a valid store path, so the next GC deleted the copies
# again and a gcroot pointing at one was skipped as an invalid root. load-db is
# a single cheap sqlite transaction over the baked closure and is idempotent, so
# re-running it every boot always converges the database to cover the closure,
# whatever state the volume arrived in.
init_store() {
  [ -e "${NIX_STATE}/db/db.sqlite" ] || NIX_CONFIG='build-users-group =' nix-store --init
  if [ -n "${VEGA_NIX_REGINFO:-}" ] && [ -e "${VEGA_NIX_REGINFO}" ]; then
    NIX_CONFIG='build-users-group =' nix-store --load-db < "${VEGA_NIX_REGINFO}"
  fi
}

# Register a persistent GC root for the builder's OWN runtime closure, so the
# in-container periodic nix-collect-garbage (run_gc) can never delete a path the
# container needs to boot. /nix is a named volume; nothing rooted the baked
# closure, so the GC eventually removed the entrypoint's store path, leaving
# /bin/vega-builder-entrypoint a dangling symlink and the container exiting 127
# (and unrecoverable under Docker's restart policy). Runs every boot, so an
# upgraded image roots its own (new) closure rather than depending on the seeded
# one. VEGA_BUILDER_ROOT (the buildEnv baked into the image) transitively
# references the entrypoint, nix and the runner, so rooting it protects the whole
# boot closure; the entrypoint and runner are rooted directly too as a fallback.
protect_boot_closure() {
  mkdir -p "${NIX_STATE}/gcroots"
  if [ -n "${VEGA_BUILDER_ROOT:-}" ] && [ -e "${VEGA_BUILDER_ROOT}" ]; then
    ln -sfn "${VEGA_BUILDER_ROOT}" "${NIX_STATE}/gcroots/vega-builder-root"
  fi
  local self
  self="$(readlink -f "$0" 2>/dev/null || true)"
  case "$self" in
    /nix/store/*) ln -sfn "$self" "${NIX_STATE}/gcroots/vega-builder-entrypoint" ;;
  esac
  if [ -n "${RUNNER_DIST:-}" ] && [ -e "${RUNNER_DIST}" ]; then
    ln -sfn "${RUNNER_DIST}" "${NIX_STATE}/gcroots/vega-builder-runner"
  fi
}

# Refuse to hand control to the runner unless the container can actually execute
# a job. A gcroot only holds when its target is a VALID (database-registered)
# store path; an invalid root is skipped and its target garbage-collected. The
# observed failure of a broken boot closure is silent and worse than being
# offline: Runner.Listener keeps running on its own deleted-but-open files, so
# the runner stays registered and keeps ACCEPTING jobs, while Runner.Worker can
# no longer spawn and every job dies at GitHub's ten-minute no-communication
# timeout. Failing here keeps the runner offline instead, so queued jobs wait.
# Checks that each root exists on disk, that Nix considers it valid AND that
# every path in its closure is actually present (load-db registers database
# rows without touching files, so after a PARTIAL reseed of a persistent volume
# the roots can be "valid" while a closure member such as glibc is a ghost);
# init_store's unconditional load-db should make validity always hold, so a
# failure here means the /nix volume is missing the image's paths (recreate the
# volume, or copy the image's /nix/store into it and restart).
preflight_boot_closure() {
  local p ok=0 err missing
  for p in "${VEGA_BUILDER_ROOT:-}" "${RUNNER_DIST:-}"; do
    [ -n "$p" ] || continue
    if [ ! -e "$p" ]; then
      echo "vega-builder: preflight: ${p} is missing from /nix/store" >&2
      ok=1
      continue
    fi
    if ! err="$(nix-store --check-validity "$p" 2>&1)"; then
      echo "vega-builder: preflight: ${p} is not a valid registered store path: ${err}" >&2
      ok=1
      continue
    fi
    missing="$(nix-store -qR "$p" 2>/dev/null \
      | while read -r q; do [ -e "$q" ] || echo "$q"; done | head -n 5)"
    if [ -n "$missing" ]; then
      echo "vega-builder: preflight: closure of ${p} has registered but absent paths (first few):" >&2
      echo "$missing" >&2
      ok=1
    fi
  done
  if [ -n "${RUNNER_DIST:-}" ] && [ ! -e "${RUNNER_DIST}/bin/run.sh" ]; then
    echo "vega-builder: preflight: ${RUNNER_DIST}/bin/run.sh is missing" >&2
    ok=1
  fi
  if [ "$ok" -ne 0 ]; then
    echo "vega-builder: preflight failed; refusing to start the runner (a broken runner accepts jobs it cannot execute). If /nix is a persistent volume, recreate it or reseed it from the image and restart." >&2
    return 1
  fi
  return 0
}

# Total bytes of the filesystem holding the store. Split out so the tests can
# stub it: the number is a property of the host, not of the logic above it.
#
# coreutils only. The image ships NO awk (see builder contents in flake.nix), and
# this runs before the runner starts, so reaching for a tool outside the closure
# would not degrade, it would abort the boot under `set -e` and leave every
# container failing to start. `-P` keeps the record on one line so the size is
# always the second field; a failure yields empty, which the caller treats as
# "unknown" rather than propagating a non-zero status into an assignment.
store_fs_bytes() {
  df -PB1 /nix 2>/dev/null | tail -n1 | tr -s ' ' | cut -d' ' -f2 || true
}

# A byte count, optionally with a binary suffix (K/M/G/T, `iB` tolerated), so an
# operator can write 25G instead of counting zeros. Prints bytes, or fails.
parse_bytes() {
  local raw="${1:-}" num unit mult
  num="${raw%%[!0-9]*}"
  unit="${raw#"$num"}"
  [ -n "$num" ] || return 1
  # A value this large is a typo, not a policy. Shell arithmetic is int64 and
  # wraps silently, and the wrap is worse than the typo: one overflow lands on a
  # negative max-free that Nix rejects (a confusing refusal to boot), another
  # lands on 0, which DISABLES the floor this exists to set. Refuse instead.
  [ "${#num}" -gt 12 ] && return 1
  case "$unit" in
    "" | B) mult=1 ;;
    K | k | KiB | kiB | KB | kB) mult=1024 ;;
    M | m | MiB | miB | MB | mB) mult=$((1024 * 1024)) ;;
    G | g | GiB | giB | GB | gB) mult=$((1024 * 1024 * 1024)) ;;
    T | t | TiB | tiB | TB | tB) mult=$((1024 * 1024 * 1024 * 1024)) ;;
    *) return 1 ;;
  esac
  echo $((num * mult))
}

# The free-space thresholds for Nix's own collector, printed as "<min> <max>".
#
# This is the only mechanism that collects DURING a build. A periodic GC, however
# frequent, runs between builds, so it cannot help when one build cycle produces
# more garbage than the disk has headroom: the build fills the disk and the host
# hits zero before the timer ever fires. Below `min-free` Nix collects until
# `max-free` is free, so the disk cannot run out while a build is running.
#
# Defaulted as a fraction of the store's filesystem rather than a fixed size,
# because a fixed one is wrong at both ends: 25 GiB on a 20 GB runner would sit
# permanently under the threshold and collect continuously, while 1 GiB on a
# large shared host is a rounding error against a build cycle. The caps stop the
# fraction running away on a very large disk.
MIN_FREE_PCT=10
MAX_FREE_PCT=25
MIN_FREE_FLOOR=$((1024 * 1024 * 1024))        # 1 GiB
MIN_FREE_CAP=$((25 * 1024 * 1024 * 1024))     # 25 GiB
MAX_FREE_CAP=$((60 * 1024 * 1024 * 1024))     # 60 GiB

resolve_free_space() {
  local total min max
  total="$(store_fs_bytes || true)"
  # Anything non-numeric (an odd df, a busy mount, no df at all) means "unknown",
  # never an arithmetic error in the boot path.
  case "${total:-}" in
    "" | *[!0-9]*) total=0 ;;
  esac

  if [ -n "${VEGA_MIN_FREE:-}" ]; then
    min="$(parse_bytes "${VEGA_MIN_FREE}")" || {
      echo "vega-builder: VEGA_MIN_FREE='${VEGA_MIN_FREE}' is not a byte count (try 25G)" >&2
      return 1
    }
  elif [ "$total" -gt 0 ]; then
    min=$((total * MIN_FREE_PCT / 100))
    [ "$min" -lt "$MIN_FREE_FLOOR" ] && min="$MIN_FREE_FLOOR"
    [ "$min" -gt "$MIN_FREE_CAP" ] && min="$MIN_FREE_CAP"
  else
    # df could not read the filesystem; fall back to the floor rather than
    # leaving the disk unprotected, which is the failure this exists to prevent.
    min="$MIN_FREE_FLOOR"
  fi

  # 0 is Nix's own "disabled", so an operator can opt out explicitly.
  if [ "$min" -le 0 ]; then
    echo "0 0"
    return 0
  fi

  if [ -n "${VEGA_MAX_FREE:-}" ]; then
    max="$(parse_bytes "${VEGA_MAX_FREE}")" || {
      echo "vega-builder: VEGA_MAX_FREE='${VEGA_MAX_FREE}' is not a byte count (try 60G)" >&2
      return 1
    }
  elif [ "$total" -gt 0 ]; then
    max=$((total * MAX_FREE_PCT / 100))
    [ "$max" -gt "$MAX_FREE_CAP" ] && max="$MAX_FREE_CAP"
  else
    max=$((min * 2))
  fi

  # Collecting has to reach a HIGHER free-space mark than the one that triggered
  # it, or Nix would collect on every check and never clear the condition.
  [ "$max" -le "$min" ] && max=$((min * 2))
  echo "${min} ${max}"
}

# Bytes as GiB with one decimal, for the boot announcement only. Shell
# arithmetic rather than awk, which the image does not ship.
gib() {
  local b="${1:-0}"
  printf '%s.%s GiB' "$((b / 1073741824))" "$(((b % 1073741824) * 10 / 1073741824))"
}

# Emit the generated nix.conf for the given sandbox mode. Split out of
# setup_nix so the test harness can assert the contents without a container.
nix_conf_contents() {
  local sandbox="$1"
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
  # Keep a build from taking the host's disk to zero: collect mid-build instead.
  # Single-user Nix means the client enforces these itself, with no daemon to
  # restart for them to take effect.
  local free_min free_max
  read -r free_min free_max <<<"$(resolve_free_space)"
  echo "min-free = ${free_min}"
  [ "${free_min}" -gt 0 ] && echo "max-free = ${free_max}"
  echo "substituters = https://cache.nixos.org ${VEGA_CACHE_URL} ${VEGA_EXTRA_SUBSTITUTERS:-}"
  echo "trusted-public-keys = ${NIXOS_CACHE_KEY} ${VEGA_CACHE_PUBKEY} ${VEGA_EXTRA_TRUSTED_PUBLIC_KEYS:-}"
}

# Minimal single-user Nix state for an ephemeral root container. The image ships
# the toolchain closure; a build fetches the rest from substituters. The sandbox
# mode is auto-detected (see resolve_sandbox): on by default when the container
# can create a user namespace, `relaxed` when it cannot.
setup_nix() {
  mkdir -p "${NIX_STATE}/db" "${NIX_STATE}/gcroots" "${NIX_STATE}/profiles" \
           "${NIX_STATE}/temproots" "${NIX_STATE}/userpool" /etc/nix
  # Init + register the baked closure before any probe or build needs it.
  init_store
  # Root the boot closure so the periodic GC cannot brick the container.
  protect_boot_closure
  # Respect an operator-mounted nix.conf: we do not rewrite it. We still enforce
  # the VEGA_NIX_SANDBOX=true contract (a `true` request must not run unsandboxed
  # because the mounted config disabled it).
  if [ -e /etc/nix/nix.conf ]; then
    enforce_required_sandbox || exit 1
    # A mounted config is the operator's to own, so we do not inject the
    # free-space thresholds into it. Say so: the failure mode of not having them
    # is a full host disk rather than a failed build, and it is invisible until
    # it happens.
    local mounted_min
    mounted_min="$(effective_setting min-free)"
    if [ -z "${mounted_min}" ] || [ "${mounted_min}" = 0 ]; then
      echo "vega-builder: WARNING: the mounted /etc/nix/nix.conf sets no min-free, so Nix will not collect during a build and a large build can take this host's disk to zero. Set min-free and max-free there (VEGA_MIN_FREE/VEGA_MAX_FREE only apply to the generated config)." >&2
    fi
  else
    # Validate the operator's thresholds BEFORE writing the file, so a typo is a
    # loud refusal rather than a config silently missing its disk guard.
    local free_min free_max sandbox
    read -r free_min free_max <<<"$(resolve_free_space)" || exit 1
    [ -n "${free_min}" ] || exit 1
    sandbox="$(resolve_sandbox)" || exit 1
    nix_conf_contents "${sandbox}" > /etc/nix/nix.conf
    echo "vega-builder: nix sandbox = ${sandbox}" >&2
    if [ "${free_min}" -gt 0 ]; then
      echo "vega-builder: store free-space floor: collect below $(gib "${free_min}") until $(gib "${free_max}") free (VEGA_MIN_FREE/VEGA_MAX_FREE)" >&2
    else
      echo "vega-builder: store free-space floor DISABLED (VEGA_MIN_FREE=0); a build can fill this disk" >&2
    fi
  fi
  # Never register a runner whose own runtime cannot execute a job.
  preflight_boot_closure || exit 1
}

# The GC backstop's trigger: the runner's own runtime is gone from the store.
# Split out so the test harness can pin the condition.
runner_runtime_missing() {
  [ -n "${RUNNER_DIST:-}" ] && [ ! -e "${RUNNER_DIST}/bin/run.sh" ]
}

# Whether to run the periodic store GC. On by default; off via VEGA_GC in
# {false,0,off}. Skipped for an EPHEMERAL runner, whose container (and store) is
# fresh per job, so nothing accumulates to collect.
gc_enabled() {
  local v="${VEGA_GC:-true}"
  case "${v,,}" in false | 0 | off | no) return 1 ;; esac
  [ "${VEGA_RUNNER_EPHEMERAL:-false}" = "true" ] && return 1
  return 0
}

# Periodically garbage-collect the Nix store so a long-lived runner's /nix does
# not grow unbounded (a persistent runner accumulates every path it ever built or
# substituted). Runs in the background alongside the runner; nix-collect-garbage
# takes the store GC lock and honors in-flight build temproots, so it never
# deletes a path a running build needs (an unrooted, older-than-threshold path is
# the normal GC target). Tunables (sleep/nix duration suffixes): VEGA_GC=false to
# disable, VEGA_GC_DELETE_OLDER_THAN (default 7d), VEGA_GC_INTERVAL (default 7d),
# VEGA_GC_INITIAL_DELAY (default 1h, so a fresh container does not GC-storm).
start_periodic_gc() {
  gc_enabled || return 0
  local older="${VEGA_GC_DELETE_OLDER_THAN:-7d}"
  local interval="${VEGA_GC_INTERVAL:-7d}"
  local delay="${VEGA_GC_INITIAL_DELAY:-1h}"
  echo "vega-builder: periodic store GC enabled (--delete-older-than ${older}, every ${interval}, first after ${delay})" >&2
  (
    sleep "$delay"
    while true; do
      summary="$(nix-collect-garbage --delete-older-than "$older" 2>&1 | tail -n1)" || true
      echo "vega-builder: periodic GC: ${summary}" >&2
      # Backstop against the silent-brick mode: if a GC ever removes the
      # runner's own runtime (it cannot once the boot closure is registered and
      # rooted, but a corrupted database or an operator wiping /nix can), the
      # already-running Runner.Listener would keep accepting jobs on its
      # deleted-but-open files and every job would die at GitHub's ten-minute
      # no-communication timeout. Stop the runner instead: offline means queued
      # jobs wait, and the restarted container fails the boot preflight loudly.
      # Signal -1 (every process in the namespace except this subshell and
      # PID 1), NOT PID 1 directly: the exec'd runner installs no TERM handler
      # on PID 1, and the kernel discards handler-less signals sent to a PID
      # namespace's init from inside, so `kill 1` succeeds while stopping
      # nothing. Killing the runner's process tree makes PID 1's run.sh see its
      # child die and exit; docker's restart then hits the boot preflight.
      if runner_runtime_missing; then
        echo "vega-builder: FATAL: the runner's own runtime (${RUNNER_DIST}) is gone from the store; stopping the runner so jobs queue instead of timing out" >&2
        kill -TERM -- -1 2>/dev/null || true
        exit 1
      fi
      sleep "$interval"
    done
  ) &
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

  # Background store GC before handing PID 1 to the runner, so a persistent
  # runner's /nix is trimmed on a schedule rather than growing without bound.
  start_periodic_gc

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
