#!/usr/bin/env bash
# Fails once the pinned GitHub Actions runner gets close to GitHub's own rolling
# minimum-version window: a runner must install each release within 30 days of
# publication or GitHub refuses it. The margin below is short of 30 so there is
# time to notice and merge a bump before the real cutoff.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

MARGIN_DAYS="${RUNNER_FRESHNESS_MARGIN_DAYS:-23}"

rev=$(jq -r '.nodes["nixpkgs-runner"].locked.rev' flake.lock)
version=$(nix eval --raw --impure --expr \
  "(import (builtins.getFlake \"github:NixOS/nixpkgs/$rev\") {}).github-runner.version")

published_at=$(gh api "repos/actions/runner/releases/tags/v$version" --jq .published_at)
if [ -z "$published_at" ]; then
  echo "could not look up the release date for github-runner $version" >&2
  exit 1
fi

published_epoch=$(date -d "$published_at" +%s)
now_epoch=$(date +%s)
age_days=$(((now_epoch - published_epoch) / 86400))

echo "pinned github-runner: $version, published $published_at ($age_days day(s) ago)"

if [ "$age_days" -gt "$MARGIN_DAYS" ]; then
  echo "::error::github-runner $version is $age_days day(s) old; bump nixpkgs-runner (nix flake update nixpkgs-runner) before GitHub's 30-day window closes it" >&2
  exit 1
fi
