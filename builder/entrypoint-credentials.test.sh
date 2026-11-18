#!/usr/bin/env bash
# Regression test: run_runner must clear GITHUB_RUNNER_TOKEN(_FILE) and
# GITHUB_PAT(_FILE) before run.sh runs, on every path, including a restart
# that reuses a saved registration and never re-registers.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$here/entrypoint.sh"

fails=0
ok() { echo "ok: $1"; }
fail() { echo "FAIL: $1" >&2; fails=$((fails + 1)); }

# Real work (Nix store init, GC) is irrelevant to credential handling; stub
# both so this test needs no container.
setup_nix() { :; }
start_periodic_gc() { :; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

run_dist="$work/dist"
mkdir -p "$run_dist/bin"
# run.sh dumps its own environment so the test can see exactly what a job
# running under it would have access to, then exits (not a real exec target).
cat > "$run_dist/bin/run.sh" <<'EOF'
#!/usr/bin/env bash
env > "$RUN_SH_ENV_DUMP"
EOF
chmod +x "$run_dist/bin/run.sh"
cat > "$run_dist/bin/config.sh" <<'EOF'
#!/usr/bin/env bash
# Pretend to register: create .runner like the real one does.
touch "$RUNNER_ROOT/.runner"
EOF
chmod +x "$run_dist/bin/config.sh"

run_one() {
  local label="$1" pre_runner_exists="$2"
  local runner_root="$work/root-$label"
  mkdir -p "$runner_root"
  [ "$pre_runner_exists" = "yes" ] && touch "$runner_root/.runner"

  local dump="$work/env-$label.txt"
  (
    export RUNNER_DIST="$run_dist"
    export RUNNER_ROOT="$runner_root"
    export RUN_SH_ENV_DUMP="$dump"
    export GITHUB_OWNER="octocat"
    export GITHUB_REPOSITORY="demo"
    export GITHUB_RUNNER_TOKEN="should-never-reach-a-job"
    export GITHUB_PAT="should-never-reach-a-job-either"
    run_runner
  )

  # Anchored to a `NAME=` line start, not a bare substring: a real CI runner
  # sets its own unrelated GITHUB_PATH (for $GITHUB_PATH step outputs), which
  # a loose `grep "GITHUB_PAT"` matches as a false leak.
  if grep -qE "^GITHUB_RUNNER_TOKEN(_FILE)?=" "$dump" 2>/dev/null; then
    fail "$label: GITHUB_RUNNER_TOKEN leaked into run.sh's environment"
  else
    ok "$label: GITHUB_RUNNER_TOKEN cleared before run.sh"
  fi
  if grep -qE "^GITHUB_PAT(_FILE)?=" "$dump" 2>/dev/null; then
    fail "$label: GITHUB_PAT leaked into run.sh's environment"
  else
    ok "$label: GITHUB_PAT cleared before run.sh"
  fi
}

# The scenario that was actually broken: a saved registration already exists
# (a plain container restart), so the registration branch is skipped entirely.
run_one "persisted-registration" yes

# The scenario that already worked: no saved registration, so the primary
# token path registers and must still clear afterward.
run_one "fresh-registration" no

if [ "$fails" -eq 0 ]; then
  echo "all entrypoint credential tests passed"
  exit 0
else
  echo "$fails entrypoint credential test(s) failed" >&2
  exit 1
fi
