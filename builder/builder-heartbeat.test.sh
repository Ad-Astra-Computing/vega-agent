#!/usr/bin/env bash
# The builder heartbeat (garnix-ci spec 0009, section 2).
# ok and fail always return 0, and the curl stub is called by the functions under test.
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
CRED="dmVnYS1idWlsZGVyOnYxOjQyOnJhY2s6YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE6MTgwMzM0ODI4MTExNg==.vega-builder-1:c2lnbmF0dXJlLXNpZ25hdHVyZQ=="
printf '%s\n' "$CRED" >"$work/cred"

# The stub records its arguments, the headers it was given on stdin, and the
# body, and answers with the status in $STUB_STATUS.
curl() {
  printf '%s\n' "$*" >>"$work/argv"
  local body="" hdr_stdin=0
  while [ $# -gt 0 ]; do
    case "$1" in
      -H) [ "$2" = "@-" ] && hdr_stdin=1; shift ;;
      -d) body="$2"; shift ;;
    esac
    shift
  done
  [ "$hdr_stdin" = 1 ] && cat >>"$work/headers"
  printf '%s\n' "$body" >>"$work/bodies"
  printf '%s' "${STUB_STATUS:-200}"
}

# Reading the credential.
got="$(read_builder_credential "$work/cred")" && [ "$got" = "$CRED" ] && ok "reads a well-formed credential file" || fail "read: $got"
read_builder_credential "$work/missing" >/dev/null 2>&1 && fail "accepted a missing file" || ok "refuses a missing file"
printf 'not a credential\n' >"$work/bad"
read_builder_credential "$work/bad" >/dev/null 2>&1 && fail "accepted a malformed file" || ok "refuses a malformed file"
printf '%s\n' "dmVnYS13b3JrZXI6djE6NDI6cmFjazozOjE4MDMzNDgyODExMTY=.vega-worker-1:c2ln" >"$work/worker"
read_builder_credential "$work/worker" >/dev/null 2>&1 && fail "accepted a worker credential" || ok "refuses a worker credential"
printf '%s\n' "dmVnYS1zaWduZXI6djE6Zmx5LTE6dmVnYToxODAzMzQ4MjgxMTE2.vega-signer-1:c2ln" >"$work/signer"
read_builder_credential "$work/signer" >/dev/null 2>&1 && fail "accepted a signer credential" || ok "refuses a signer credential"
head -c 5000 /dev/zero | tr '\0' 'a' >"$work/big"
read_builder_credential "$work/big" >/dev/null 2>&1 && fail "accepted an oversized file" || ok "refuses an oversized file"

# One report.
: >"$work/argv"; : >"$work/headers"; : >"$work/bodies"
code="$(VEGA_BUILDER_VERSION=0.26.0 builder_report_once "$CRED")"
[ "$code" = 200 ] && ok "reports and returns the status" || fail "status: $code"
grep -q "authorization: Bearer $CRED" "$work/headers" && ok "sends the credential as a header on stdin" || fail "header missing"
grep -q -- "$CRED" "$work/argv" && fail "the credential appeared in curl's arguments" || ok "keeps the credential out of the process list"
[ "$(cat "$work/bodies")" = '{"version":"0.26.0","deployment":"container"}' ] && ok "sends only its version and deployment" || fail "body: $(cat "$work/bodies")"
grep -q "https://vega-cache.dev/api/fleet/report" "$work/argv" && ok "reports to the production control plane by default" || fail "url: $(cat "$work/argv")"
: >"$work/bodies"
VEGA_BUILDER_VERSION='0.26.0","x":"y' builder_report_once "$CRED" >/dev/null
[ "$(cat "$work/bodies")" = '{"version":"unknown","deployment":"container"}' ] && ok "never sends a malformed version" || fail "body: $(cat "$work/bodies")"

# Enabling.
VEGA_BUILDER_CREDENTIAL_FILE="$work/cred" builder_heartbeat_enabled && ok "on with a credential file" || fail "off with a credential file"
(unset VEGA_BUILDER_CREDENTIAL_FILE; builder_heartbeat_enabled) && fail "on without a credential file" || ok "off without a credential file"
for off in false 0 off no; do
  VEGA_TELEMETRY="$off" VEGA_BUILDER_CREDENTIAL_FILE="$work/cred" builder_heartbeat_enabled && fail "VEGA_TELEMETRY=$off left it on" || ok "VEGA_TELEMETRY=$off turns it off"
done

# The loop: it reports while the runner is up, stops when the runner exits,
# and stops for good on a refused credential.
sleep 2 &
runner=$!
: >"$work/bodies"
out="$(BUILDER_REPORT_INTERVAL=0.2 STUB_STATUS=200 builder_heartbeat_loop "$runner" "$CRED" 2>&1)"
n="$(wc -l <"$work/bodies")"
[ "$n" -ge 3 ] && ok "reports repeatedly while the runner is up ($n)" || fail "reports: $n"
[[ "$out" == *"reporting to Vega"* ]] && [[ "$out" != *"$CRED"* ]] && ok "says it is reporting, without the credential" || fail "log: $out"

sleep 5 &
runner=$!
: >"$work/bodies"
out="$(BUILDER_REPORT_INTERVAL=0.2 STUB_STATUS=401 builder_heartbeat_loop "$runner" "$CRED" 2>&1)"
[ "$(wc -l <"$work/bodies")" = 1 ] && [[ "$out" == *"vega builder enroll"* ]] && ok "stops on a refused credential and says how to fix it" || fail "401: $(wc -l <"$work/bodies") $out"
kill "$runner" 2>/dev/null

sleep 1 &
runner=$!
: >"$work/bodies"
out="$(BUILDER_REPORT_INTERVAL=0.2 STUB_STATUS=429 builder_heartbeat_loop "$runner" "$CRED" 2>&1)"
[ -z "$out" ] && ok "says nothing while rate limited" || fail "429 log: $out"

[ "$fails" = 0 ] || { echo "$fails failure(s)" >&2; exit 1; }
echo "all builder-heartbeat tests passed"
