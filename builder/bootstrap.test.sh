#!/usr/bin/env bash
# Tests for the boot shim (builder/bootstrap.sh). The shim's job: exec the
# real entrypoint when it resolves; when a persistent /nix volume masks the
# image's store (dangling entrypoint symlink), seed the baked copy additively
# and then exec. Paths are baked into the script, so each case rewrites them
# into a sandbox copy with sed.
#
# Every case runs twice: once under the host shell (fast, always available)
# and once under a REAL busybox with an empty PATH, faithfully modeling the
# production heal environment (busybox ash, no external tools resolvable).
# The busybox pass exists because busybox semantics differ where it hurts:
# its cp -n skips an existing destination directory wholesale instead of
# merging, and non-builtins resolve via PATH, both of which broke the first
# version of this shim while the host-shell tests stayed green. Locate one
# via BOOTSTRAP_TEST_BUSYBOX or PATH; without one the busybox pass is
# SKIPPED with a notice.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fails=0

busybox="${BOOTSTRAP_TEST_BUSYBOX:-$(command -v busybox || true)}"

# setup <runner> -> $tmp with bin/, nix/store/, nix-seed/store/ and a
# sandboxed bootstrap rewired to those paths. runner=host rewires $bb to a
# pass-through so `"$bb" cp ...` uses host tools; runner=busybox rewires it
# to the real busybox binary.
setup() {
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/bin" "$tmp/nix/store" "$tmp/nix-seed/store"
  # The copy must be NAMED busybox: the multiplexer engages on basename(argv0).
  local bb_target="$tmp/bin/busybox"
  if [ "$1" = busybox ]; then
    cp "$busybox" "$bb_target"
  else
    printf '#!/bin/sh\nexec "$@"\n' > "$bb_target"
  fi
  chmod 755 "$bb_target"
  sed -e "s|/bin/vega-builder-entrypoint|$tmp/bin/vega-builder-entrypoint|g" \
      -e "s|/bin/busybox|$bb_target|g" \
      -e "s|/nix-seed|$tmp/nix-seed|g" \
      -e "s|/nix/store|$tmp/nix/store|g" \
      "$here/bootstrap.sh" > "$tmp/bootstrap"
  chmod 755 "$tmp/bootstrap"
}

# run_shim <runner> [args...]: host runs via sh; busybox runs via the real
# interpreter with PATH emptied, exactly like the heal environment. The image
# sets VEGA_BUILDER_ROOT and RUNNER_DIST in the container Env, and the shim gates
# its fast path on them, so forward them here (defaulting to a nonexistent path,
# which the shim treats as "not seeded" and routes to the seed path). The busybox
# pass clears the environment with env -i, so they must be passed explicitly.
run_shim() {
  local runner="$1"; shift
  local vbroot="${VBROOT:-/nonexistent}" rdist="${RDIST:-/nonexistent}"
  if [ "$runner" = busybox ]; then
    env -i PATH=/nonexistent VEGA_BUILDER_ROOT="$vbroot" RUNNER_DIST="$rdist" \
      "$tmp/bin/busybox" sh "$tmp/bootstrap" "$@"
  else
    env VEGA_BUILDER_ROOT="$vbroot" RUNNER_DIST="$rdist" sh "$tmp/bootstrap" "$@"
  fi
}

check() {
  local runner="$1" name="$2" want_rc="$3" want_out="$4" got_rc got_out
  got_out="$(run_shim "$runner" one two 2>/dev/null)"
  got_rc=$?
  if [ "$got_rc" != "$want_rc" ] || [ "$got_out" != "$want_out" ]; then
    echo "FAIL($runner): $name -> rc=$got_rc out='$got_out' (want rc=$want_rc out='$want_out')" >&2
    fails=$((fails + 1))
  else
    echo "ok($runner): $name"
  fi
}

# A fake entrypoint printing its args, so exec + argument forwarding is pinned.
# Plain shebang: in the busybox pass PATH is empty but shebangs use absolute
# interpreter paths, and /bin/sh exists on any test host.
plant() {
  printf '#!/bin/sh\necho "entrypoint ran: $*"\n' > "$1"
  chmod 755 "$1"
}

suite() {
  local runner="$1"

  # Fast path: the whole closure resolves (entrypoint, builder root and runner);
  # the seed must not even be read, and the boot must positively attest which
  # path it took (a healthy boot and an inert shim must not look identical).
  setup "$runner"
  plant "$tmp/nix/store/real-entrypoint"
  ln -s "$tmp/nix/store/real-entrypoint" "$tmp/bin/vega-builder-entrypoint"
  mkdir -p "$tmp/nix/store/builder-root" "$tmp/nix/store/runner"
  VBROOT="$tmp/nix/store/builder-root"; RDIST="$tmp/nix/store/runner"
  : > "$tmp/nix-seed/store/sentinel"
  err="$(run_shim "$runner" 2>&1 >/dev/null)"
  case "$err" in
    *"store complete, direct handoff"*) echo "ok($runner): fast path attests itself" ;;
    *) echo "FAIL($runner): fast path printed no attestation line (stderr: '$err')" >&2; fails=$((fails + 1)) ;;
  esac
  check "$runner" "resolving entrypoint execs directly" 0 "entrypoint ran: one two"
  if [ -e "$tmp/nix/store/sentinel" ]; then
    echo "FAIL($runner): fast path copied the seed" >&2; fails=$((fails + 1))
  else
    echo "ok($runner): fast path leaves the seed untouched"
  fi
  rm -rf "$tmp"

  # Changed closure, UNCHANGED entrypoint: the 0.17.0 -> 0.17.1 shape, where the
  # runner is bumped off a separate pin while the entrypoint derivation is
  # byte-identical. On a persistent volume the entrypoint still resolves, but the
  # new runner and the buildEnv over the whole closure are absent. An
  # entrypoint-only fast path would hand off to a store missing the new runner and
  # the preflight would re-brick the very upgrade meant to fix one. The shim must
  # seed, keyed on VEGA_BUILDER_ROOT and RUNNER_DIST, not the entrypoint alone.
  setup "$runner"
  mkdir -p "$tmp/nix/store/entry/bin"
  plant "$tmp/nix/store/entry/bin/run"
  ln -s "$tmp/nix/store/entry/bin/run" "$tmp/bin/vega-builder-entrypoint"
  mkdir -p "$tmp/nix-seed/store/entry/bin"; plant "$tmp/nix-seed/store/entry/bin/run"
  mkdir -p "$tmp/nix-seed/store/new-runner" "$tmp/nix-seed/store/new-root"
  : > "$tmp/nix-seed/store/new-runner/run.sh"
  VBROOT="$tmp/nix/store/new-root"; RDIST="$tmp/nix/store/new-runner"
  check "$runner" "changed closure with unchanged entrypoint seeds then execs" 0 "entrypoint ran: one two"
  rm -rf "$tmp"

  setup "$runner"
  mkdir -p "$tmp/nix/store/entry/bin"
  plant "$tmp/nix/store/entry/bin/run"
  ln -s "$tmp/nix/store/entry/bin/run" "$tmp/bin/vega-builder-entrypoint"
  mkdir -p "$tmp/nix-seed/store/entry/bin"; plant "$tmp/nix-seed/store/entry/bin/run"
  mkdir -p "$tmp/nix-seed/store/new-runner" "$tmp/nix-seed/store/new-root"
  : > "$tmp/nix-seed/store/new-runner/run.sh"
  VBROOT="$tmp/nix/store/new-root"; RDIST="$tmp/nix/store/new-runner"
  err="$(run_shim "$runner" 2>&1 >/dev/null)"
  case "$err" in
    *"seeding the baked store copy"*)
      case "$err" in
        *"direct handoff"*) echo "FAIL($runner): changed-closure took the fast path (re-brick)" >&2; fails=$((fails + 1)) ;;
        *) echo "ok($runner): changed closure seeds instead of direct handoff" ;;
      esac ;;
    *) echo "FAIL($runner): changed closure printed no seeding line (stderr: '$err')" >&2; fails=$((fails + 1)) ;;
  esac
  if [ -e "$tmp/nix/store/new-runner/run.sh" ]; then
    echo "ok($runner): the new runner is seeded into the volume"
  else
    echo "FAIL($runner): the new runner was not seeded" >&2; fails=$((fails + 1))
  fi
  rm -rf "$tmp"
  unset VBROOT RDIST

  # Heal path: the /bin symlink dangles, the seed holds the target (a store
  # path DIRECTORY, like the real layout), plus the volume already has an
  # unrelated path that must survive untouched.
  setup "$runner"
  mkdir -p "$tmp/nix-seed/store/aaa-entry/bin"
  plant "$tmp/nix-seed/store/aaa-entry/bin/run"
  mkdir -p "$tmp/nix/store/bbb-existing"
  printf 'volume copy\n' > "$tmp/nix/store/bbb-existing/marker"
  mkdir -p "$tmp/nix-seed/store/bbb-existing"
  printf 'seed copy\n' > "$tmp/nix-seed/store/bbb-existing/marker"
  ln -s "$tmp/nix/store/aaa-entry/bin/run" "$tmp/bin/vega-builder-entrypoint"
  check "$runner" "dangling entrypoint seeds then execs" 0 "entrypoint ran: one two"

  # Re-run the heal assertions on a fresh sandbox so both are checked.
  setup "$runner"
  mkdir -p "$tmp/nix-seed/store/aaa-entry/bin"
  plant "$tmp/nix-seed/store/aaa-entry/bin/run"
  mkdir -p "$tmp/nix/store/bbb-existing"
  printf 'volume copy\n' > "$tmp/nix/store/bbb-existing/marker"
  mkdir -p "$tmp/nix-seed/store/bbb-existing"
  printf 'seed copy\n' > "$tmp/nix-seed/store/bbb-existing/marker"
  ln -s "$tmp/nix/store/aaa-entry/bin/run" "$tmp/bin/vega-builder-entrypoint"
  err="$(run_shim "$runner" 2>&1 >/dev/null)"
  case "$err" in
    *"seeding the baked store copy"*)
      case "$err" in
        *"direct handoff"*) echo "FAIL($runner): heal path also printed the fast-path line" >&2; fails=$((fails + 1)) ;;
        *) echo "ok($runner): heal path attests seeding, not direct handoff" ;;
      esac ;;
    *) echo "FAIL($runner): heal path printed no seeding line (stderr: '$err')" >&2; fails=$((fails + 1)) ;;
  esac
  if [ "$(cat "$tmp/nix/store/bbb-existing/marker")" = "volume copy" ]; then
    echo "ok($runner): seeding never overwrites existing volume paths"
  else
    echo "FAIL($runner): seeding overwrote an existing volume path" >&2
    fails=$((fails + 1))
  fi
  rm -rf "$tmp"

  # No seed in the image: fail loudly with 64, never exec a dangling target.
  setup "$runner"
  rm -rf "$tmp/nix-seed"
  ln -s "$tmp/nix/store/missing" "$tmp/bin/vega-builder-entrypoint"
  check "$runner" "missing seed fails with 64" 64 ""

  # Seed present but healing cannot make the entrypoint resolve.
  setup "$runner"
  mkdir -p "$tmp/nix-seed/store/ccc-other"
  ln -s "$tmp/nix/store/missing" "$tmp/bin/vega-builder-entrypoint"
  check "$runner" "unhealable store fails with 64" 64 ""
}

suite host
if [ -n "$busybox" ] && [ -x "$busybox" ]; then
  suite busybox
else
  echo "NOTICE: no busybox found (set BOOTSTRAP_TEST_BUSYBOX); the busybox pass was SKIPPED" >&2
fi

if [ "$fails" -ne 0 ]; then
  echo "$fails test(s) failed" >&2
  exit 1
fi
echo "all bootstrap tests passed"
