#!/usr/bin/env bash
# Unit tests for resolve_sandbox's decision tree (builder/entrypoint.sh).
#
# The real probe runs a Nix build, which needs a container; here we source the
# entrypoint (its main() is guarded, so nothing runs) and stub probe_sandbox to
# return each outcome, then assert resolve_sandbox's stdout and exit status. This
# pins the set -e interactions: an `auto` fallback must NOT be turned into a hard
# exit by errexit, and a `true` failure MUST abort.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$here/entrypoint.sh"
set +e  # the driver inspects non-zero returns; do not let them abort the run.

fails=0
PROBE_RC=0
probe_sandbox() { return "$PROBE_RC"; }  # stub: outcome set per case via PROBE_RC

# check <name> <VEGA_NIX_SANDBOX> <probe_rc> <expect_rc> <expect_out>
check() {
  local name="$1" env_val="$2" probe_rc="$3" want_rc="$4" want_out="$5"
  PROBE_RC="$probe_rc"
  local out rc
  out="$(VEGA_NIX_SANDBOX="$env_val" resolve_sandbox 2>/dev/null)"
  rc=$?
  if [ "$rc" != "$want_rc" ] || [ "$out" != "$want_out" ]; then
    echo "FAIL: $name -> rc=$rc out='$out' (want rc=$want_rc out='$want_out')" >&2
    fails=$((fails + 1))
  else
    echo "ok: $name"
  fi
}

# explicit off: never probes
check "false stays false"            false  0  0 false
# explicit true: probe decides, failure is fatal (no silent unsandboxed build)
check "true + works"                 true   0  0 true
check "true + no userns -> fatal"    true  10  1 ""
check "true + unrelated -> fatal"    true   1  1 ""
# auto (default): downgrade to relaxed only on a real userns failure
check "auto + works"                 auto   0  0 true
check "auto + no userns -> relaxed"  auto  10  0 relaxed
check "auto + unrelated -> fatal"    auto   1  1 ""
# unset env defaults to auto
check "unset defaults to auto"       ""     0  0 true
# unknown value falls through to the auto arm
check "garbage -> auto behavior"     yes    0  0 true

# enforce_required_sandbox: holds the "true means GUARANTEED sandboxed" contract
# against an operator-mounted nix.conf, i.e. effective sandbox=true AND
# sandbox-fallback=false. Stub the effective settings.
EFF_SANDBOX=true
EFF_FALLBACK=false
effective_setting() {
  case "$1" in
    sandbox) printf '%s' "$EFF_SANDBOX" ;;
    sandbox-fallback) printf '%s' "$EFF_FALLBACK" ;;
  esac
}

# enforce <name> <VEGA_NIX_SANDBOX> <eff_sandbox> <eff_fallback> <want_rc>
enforce() {
  local name="$1" env_val="$2" eff_sb="$3" eff_fb="$4" want_rc="$5"
  EFF_SANDBOX="$eff_sb"; EFF_FALLBACK="$eff_fb"
  local rc
  VEGA_NIX_SANDBOX="$env_val" enforce_required_sandbox 2>/dev/null
  rc=$?
  if [ "$rc" != "$want_rc" ]; then
    echo "FAIL: enforce $name -> rc=$rc (want $want_rc)" >&2
    fails=$((fails + 1))
  else
    echo "ok: enforce $name"
  fi
}

enforce "auto never enforces"           auto  false false 0
enforce "false never enforces"          false false true  0
enforce "true + sandbox=true,fb=false"  true  true  false 0
enforce "true + fb=true fatal"          true  true  true  1
enforce "true + sandbox=false fatal"    true  false false 1
enforce "true + sandbox=relaxed fatal"  true  relaxed false 1
enforce "true + both unset fatal"       true  ""    ""    1

# gc_enabled: periodic store GC gate. On by default; off via VEGA_GC in
# {false,0,off} or for an ephemeral runner.
# gc <name> <VEGA_GC> <VEGA_RUNNER_EPHEMERAL> <want_rc> (0=enabled, 1=disabled)
gc() {
  local name="$1" vgc="$2" eph="$3" want_rc="$4" rc=0
  VEGA_GC="$vgc" VEGA_RUNNER_EPHEMERAL="$eph" gc_enabled || rc=$?
  if [ "$rc" != "$want_rc" ]; then
    echo "FAIL: gc $name -> rc=$rc (want $want_rc)" >&2
    fails=$((fails + 1))
  else
    echo "ok: gc $name"
  fi
}

gc "default on"             ""      false 0
gc "explicit true on"       true    false 0
gc "false disables"         false   false 1
gc "0 disables"             0       false 1
gc "off disables"           off     false 1
gc "ephemeral disables"     true    true  1
gc "off+ephemeral disabled" false   true  1
gc "False (case-insensitive)" False   false 1
gc "OFF (case-insensitive)"   OFF     false 1

# nix_conf_contents: the generated nix.conf must substitute from the Vega cache
# (with its key trusted) in addition to cache.nixos.org, and still append the
# operator's extra caches. This pins the fix for the builder that could not
# substitute its own prior outputs and recompiled everything from source.
conf_has() {
  local name="$1" conf="$2" want="$3"
  if printf '%s\n' "$conf" | grep -qF "$want"; then
    echo "ok: conf $name"
  else
    echo "FAIL: conf $name -> missing '$want' in:"$'\n'"$conf" >&2
    fails=$((fails + 1))
  fi
}

conf="$(VEGA_EXTRA_SUBSTITUTERS="https://extra.example" \
        VEGA_EXTRA_TRUSTED_PUBLIC_KEYS="extra.example-1:AAAA=" \
        nix_conf_contents true)"
conf_has "substituters incl vega + extra" "$conf" \
  "substituters = https://cache.nixos.org https://vega-cache.dev https://extra.example"
conf_has "keys incl nixos" "$conf" "cache.nixos.org-1:"
conf_has "keys incl vega" "$conf" \
  "vega-cache-1:cPagS1g69NQGwlBCyTTeKav/NhlN8a7ixuj2uLOkHrQ="
conf_has "keys incl extra" "$conf" "extra.example-1:AAAA="
conf_has "sandbox true pins fallback off" "$conf" "sandbox-fallback = false"
conf="$(nix_conf_contents relaxed)"
conf_has "relaxed keeps vega substituter" "$conf" "https://vega-cache.dev"
if printf '%s\n' "$conf" | grep -q "sandbox-fallback"; then
  echo "FAIL: conf relaxed must not set sandbox-fallback" >&2
  fails=$((fails + 1))
else
  echo "ok: conf relaxed omits sandbox-fallback"
fi

# init_store + preflight_boot_closure: the store logic behind the persistent
# /nix volume. Stub nix-store, point NIX_STATE at a scratch directory and pin:
# (a) the baked closure registration is loaded on EVERY boot (the old marker
# file skipped it after a recovery copy, leaving the copies unregistered and
# GC-deletable); (b) the preflight refuses to start a runner whose own runtime
# is missing or unregistered, instead of letting it accept jobs it cannot run.
NIX_STORE_CALLS=()
CHECK_VALIDITY_RC=0
QR_OUTPUT=""
nix-store() {
  NIX_STORE_CALLS+=("$*")
  case "$1" in
    --check-validity) return "$CHECK_VALIDITY_RC" ;;
    -qR) [ -n "$QR_OUTPUT" ] && printf '%s\n' "$QR_OUTPUT" ;;
  esac
  return 0
}

tmp="$(mktemp -d)"
NIX_STATE="$tmp/var/nix"
mkdir -p "$NIX_STATE/db"
: > "$NIX_STATE/db/db.sqlite"                     # store already initialized
VEGA_NIX_REGINFO="$tmp/nix-registration"
printf 'reginfo' > "$VEGA_NIX_REGINFO"
# A marker exactly as the old code would have written it for THIS registration
# (first 32 hex of its sha256). The old init_store skipped load-db when it
# existed; the new one must ignore it and load anyway.
: > "$NIX_STATE/db/.vega-registered-$(sha256sum "$VEGA_NIX_REGINFO" | cut -c1-32)"

loaddb_count() {
  local n=0 c
  for c in ${NIX_STORE_CALLS[@]+"${NIX_STORE_CALLS[@]}"}; do
    case "$c" in *--load-db*) n=$((n + 1)) ;; esac
  done
  printf '%s' "$n"
}

init_store
init_store
if [ "$(loaddb_count)" = 2 ]; then
  echo "ok: init_store loads the registration on every boot"
else
  echo "FAIL: init_store -> load-db ran $(loaddb_count) time(s), want 2 (must not be skipped by a marker)" >&2
  fails=$((fails + 1))
fi

# preflight <name> <builder_root> <runner_dist> <validity_rc> <qr_output> <want_rc>
preflight() {
  local name="$1" root="$2" dist="$3" validity="$4" qr="$5" want_rc="$6" rc=0
  CHECK_VALIDITY_RC="$validity"
  QR_OUTPUT="$qr"
  VEGA_BUILDER_ROOT="$root" RUNNER_DIST="$dist" preflight_boot_closure 2>/dev/null || rc=$?
  if [ "$rc" != "$want_rc" ]; then
    echo "FAIL: preflight $name -> rc=$rc (want $want_rc)" >&2
    fails=$((fails + 1))
  else
    echo "ok: preflight $name"
  fi
}

root="$tmp/store/builder-root"; dist="$tmp/store/github-runner"
mkdir -p "$root" "$dist/bin"
: > "$dist/bin/run.sh"
preflight "healthy closure passes"    "$root"         "$dist" 0 ""              0
preflight "missing path fails"        "$tmp/store/no" "$dist" 0 ""              1
preflight "unregistered path fails"   "$root"         "$dist" 1 ""              1
# load-db registers rows without touching files: a closure member can be
# registered yet absent after a partial reseed. The preflight must walk the
# closure, not just the roots.
preflight "ghost closure member fails" "$root"        "$dist" 0 "$tmp/store/no" 1
preflight "present closure member ok"  "$root"        "$dist" 0 "$root"         0
rm "$dist/bin/run.sh"
preflight "missing run.sh fails"      "$root"         "$dist" 0 ""              1

# runner_runtime_missing: the periodic GC backstop's trigger.
rr() {
  local name="$1" dist="$2" want_rc="$3" rc=0
  RUNNER_DIST="$dist" runner_runtime_missing || rc=$?
  if [ "$rc" != "$want_rc" ]; then
    echo "FAIL: rr $name -> rc=$rc (want $want_rc)" >&2
    fails=$((fails + 1))
  else
    echo "ok: rr $name"
  fi
}
rr "runtime gone triggers"    "$dist" 0
: > "$dist/bin/run.sh"
rr "runtime present does not" "$dist" 1
rr "unset RUNNER_DIST does not" ""    1
rm -rf "$tmp"

if [ "$fails" -ne 0 ]; then
  echo "$fails test(s) failed" >&2
  exit 1
fi
echo "all entrypoint sandbox tests passed"
