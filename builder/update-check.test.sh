#!/usr/bin/env bash
# The builder's update check (garnix-ci spec 0008, section 5).
# ok and fail always return 0, and the curl stub is called by update_check_once.
# shellcheck disable=SC2015,SC2329
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$here/entrypoint.sh"

fails=0
ok() { echo "ok: $1"; }
fail() { echo "FAIL: $1" >&2; fails=$((fails + 1)); }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# One record per case, in the shape releases.json takes, for vega-agent.
record() {
  local latest="$1" required="$2"
  jq -n --arg latest "$latest" --argjson required "$required" '{
    "vega-agent": { latest: $latest, sha: ("c" * 40), required: $required },
    "repro-worker": { latest: "0.2.0", required: null }
  }'
}

n="$(jq '.cases | length' "$here/version-states.json")"
for ((i = 0; i < n; i++)); do
  c="$(jq -c ".cases[$i]" "$here/version-states.json")"
  v="$(jq -r '.version' <<<"$c")"
  latest="$(jq -r '.latest' <<<"$c")"
  req="$(jq -c 'if .required == null then null else .required + {reason: "x"} end' <<<"$c")"
  today="$(jq -r '.today' <<<"$c")"
  want="$(jq -r '.state' <<<"$c")"
  record "$latest" "$req" >"$work/r.json"
  got="$(version_state "$v" "$work/r.json" "$today")"
  [ "$got" = "$want" ] && ok "state of '$v' is $want" || fail "state of '$v' on $today: got $got, want $want"
done

good="$(record 0.23.0 null)"
echo "$good" >"$work/good.json"
valid_release_record "$work/good.json" && ok "accepts a well-formed record" || fail "rejected a well-formed record"
for bad in \
  '{"vega-agent": {"latest": "0.23.0", "sha": "cccccccccccccccccccccccccccccccccccccccc", "required": null}}' \
  '{"vega-agent": {"latest": "latest", "sha": "cccccccccccccccccccccccccccccccccccccccc", "required": null}, "repro-worker": {"latest": "0.2.0", "required": null}}' \
  '{"vega-agent": {"latest": "0.23.0", "sha": "cccccccccccccccccccccccccccccccccccccccc", "required": {"version": "0.24.0", "from": "2026-12-01", "reason": "x"}}, "repro-worker": {"latest": "0.2.0", "required": null}}' \
  '{"vega-agent": {"latest": "0.23.0", "sha": "cccccccccccccccccccccccccccccccccccccccc", "required": {"version": "0.22.0", "from": "soon", "reason": "x"}}, "repro-worker": {"latest": "0.2.0", "required": null}}' \
  '{"vega-agent": {"latest": "0.23.0", "sha": "cccccccccccccccccccccccccccccccccccccccc", "required": {"version": "0.22.0", "from": "2026-12-01", "reason": "a\u202eb"}}, "repro-worker": {"latest": "0.2.0", "required": null}}' \
  'not json'; do
  echo "$bad" >"$work/bad.json"
  valid_release_record "$work/bad.json" && fail "accepted: $bad" || ok "rejects a malformed record"
done

# The fetch is stubbed; what is checked is what the builder does with it.
check_with() {
  local body="$1" version="$2"
  curl() {
    local out=""
    while [ $# -gt 0 ]; do
      case "$1" in -o) out="$2"; shift ;; esac
      shift
    done
    [ "$body" = "FAIL" ] && return 22
    printf '%s' "$body" >"$out"
  }
  VEGA_BUILDER_VERSION="$version" update_check_once 2>&1
  local rc=$?
  unset -f curl
  return $rc
}

out="$(check_with "$(record 0.23.0 null)" 0.23.0)"; rc=$?
[ "$rc" = 0 ] && [ -z "$out" ] && ok "says nothing when current" || fail "current: rc=$rc out=$out"

out="$(check_with "$(record 0.23.0 null)" 0.22.3)"; rc=$?
[ "$rc" = 0 ] && [[ "$out" == *"vega-agent 0.23.0 is available; this builder runs 0.22.3"* ]] \
  && ok "says when a newer release exists" || fail "behind: rc=$rc out=$out"

out="$(check_with "$(record 0.23.0 '{"version": "0.23.0", "from": "2000-01-01", "reason": "Fixes a store leak."}')" 0.22.3)"; rc=$?
[ "$rc" = 0 ] && [[ "$out" == *"UPDATE REQUIRED: Vega requires vega-agent 0.23.0 since 2000-01-01 and this builder runs 0.22.3. Fixes a store leak."* ]] \
  && ok "says loudly when an update is required" || fail "required: rc=$rc out=$out"

out="$(check_with FAIL 0.22.3)"; rc=$?
[ "$rc" = 0 ] && [[ "$out" == *"could not fetch"* ]] && ok "a failed fetch logs one line and does not fail" || fail "fetch failure: rc=$rc out=$out"

out="$(check_with 'not json' 0.22.3)"; rc=$?
[ "$rc" = 0 ] && [[ "$out" == *"not a valid release record"* ]] && ok "an invalid record logs one line and does not fail" || fail "invalid: rc=$rc out=$out"

for off in false 0 off no; do
  VEGA_UPDATE_CHECK="$off" update_check_enabled && fail "VEGA_UPDATE_CHECK=$off left it on" || ok "VEGA_UPDATE_CHECK=$off turns it off"
done
update_check_enabled && ok "on by default" || fail "off by default"

[ "$fails" = 0 ] || { echo "$fails failure(s)" >&2; exit 1; }
echo "all update-check tests passed"
