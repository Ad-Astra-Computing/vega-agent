#!/usr/bin/env bash
# Proves nix-store --verify --check-contents (what store_verify_once
# in entrypoint.sh runs) actually catches the failure class this exists for: a
# store path whose registered hash no longer matches its on-disk content, the
# way a build killed mid-write can leave one. Against a real, throwaway local
# store, not a stub, since the thing under test is Nix's own detection.
set -euo pipefail

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
store="$work/store"
payload="$work/payload.txt"

fails=0
check() {
  local name="$1" want_rc="$2" rc="$3"
  if [ "$rc" != "$want_rc" ]; then
    echo "FAIL: $name -> rc=$rc (want $want_rc)" >&2
    fails=$((fails + 1))
  else
    echo "ok: $name"
  fi
}

echo "hello" >"$payload"
added="$(nix --extra-experimental-features "nix-command" store add-file --store "$store" "$payload")"
rel="${added#/nix/store/}"
onDisk="$store/nix/store/$rel"

rc=0
nix-store --store "$store" --verify --check-contents >/dev/null 2>&1 || rc=$?
check "clean store verifies" 0 "$rc"

chmod u+w "$onDisk"
echo "corrupted" >"$onDisk"
chmod u-w "$onDisk"

rc=0
out="$(nix-store --store "$store" --verify --check-contents 2>&1)" || rc=$?
check "corrupted store fails verify" 1 "$rc"
case "$out" in
  *"was modified"*) echo "ok: reports the corrupted path" ;;
  *)
    echo "FAIL: verify output did not name the corruption: $out" >&2
    fails=$((fails + 1))
    ;;
esac

rc=0
out="$(nix-store --store "$store" --verify --check-contents --repair 2>&1)" || rc=$?
check "repair without a substituter still fails loudly" 1 "$rc"
case "$out" in
  *"cannot repair"*) echo "ok: repair reports it could not fix the path" ;;
  *)
    echo "FAIL: --repair output did not report the failed fix: $out" >&2
    fails=$((fails + 1))
    ;;
esac

if [ "$fails" -eq 0 ]; then
  echo "all store-verify tests passed"
else
  echo "$fails test(s) failed" >&2
  exit 1
fi
