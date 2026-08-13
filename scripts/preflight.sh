#!/usr/bin/env bash
# Everything that must be true before this repository is pushed, tagged or
# released, with every exit code checked.
#
# This exists because of a specific failure rather than as a formality. The test
# suite printed "245 passed" and exited 1, an import side effect having killed a
# worker, and the passing line was reported as proof while the exit code said
# otherwise. Reading output is not checking a result. Every step below is judged
# by its status, and the summary at the end is the only thing worth quoting.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

pass=0
fail=0

run() {
  local name="$1"
  shift
  local out
  if out="$("$@" 2>&1)"; then
    printf 'ok    %s\n' "$name"
    pass=$((pass + 1))
  else
    printf 'FAIL  %s (exit %d)\n' "$name" "$?"
    printf '%s\n' "$out" | tail -25 | sed 's/^/      /'
    fail=$((fail + 1))
  fi
}

run "typecheck" npm run typecheck
run "unit tests" npm test
run "builder bootstrap" bash builder/bootstrap.test.sh

# The version lives in two files and a changelog heading. They drift silently:
# a release with a stale version reports the wrong thing to every user through
# `vega doctor`, and an empty changelog section means the release says nothing
# about itself.
# Three files carry the version, and a release that misses one reports the wrong
# thing through `vega doctor` or tags the wrong builder image. The bump that
# prompted this check missed flake.nix, so the check covers all three and the
# changelog section that has to exist alongside them.
run "version files agree" bash -c '
  pkg=$(node -p "require(\"./package.json\").version")
  cli=$(grep -oE "\"[0-9]+\.[0-9]+\.[0-9]+\"" cli/version.ts | head -1 | tr -d \")
  flake=$(grep -oE "version = \"[0-9]+\.[0-9]+\.[0-9]+\"" flake.nix | grep -oE "[0-9]+\.[0-9]+\.[0-9]+" | head -1)
  [ "$pkg" = "$cli" ] || { echo "package.json $pkg != cli/version.ts $cli"; exit 1; }
  [ "$pkg" = "$flake" ] || { echo "package.json $pkg != flake.nix $flake"; exit 1; }
  grep -q "^## \[$pkg\]" CHANGELOG.md || { echo "no CHANGELOG section for $pkg"; exit 1; }
  echo "$pkg"
'

# Every command has to at least start. A registration mistake in main.ts is
# invisible to the unit tests and obvious here.
run "every command responds" bash -c '
  for c in doctor report status verify diff trust view push gate assess dashboard mcp login logout init whoami; do
    ./node_modules/.bin/tsx cli/main.ts "$c" --help >/dev/null 2>&1 || { echo "vega $c --help failed"; exit 1; }
  done
'

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
