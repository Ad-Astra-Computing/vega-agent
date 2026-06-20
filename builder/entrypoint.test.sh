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

if [ "$fails" -ne 0 ]; then
  echo "$fails test(s) failed" >&2
  exit 1
fi
echo "all entrypoint sandbox tests passed"
