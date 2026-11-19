#!/usr/bin/env bash
# Fails once the pinned GitHub Actions runner gets close to GitHub's own rolling
# minimum-version window: a runner must install each release within 30 days of
# publication or GitHub refuses it. The clock only starts once a NEWER release
# ships, so this passes outright while the pin is still the latest release, and
# otherwise measures from the latest release's publish date. The margin below
# is short of 30 so there is time to notice and merge a bump.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

MARGIN_DAYS="${RUNNER_FRESHNESS_MARGIN_DAYS:-23}"
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
REV_RE='^[0-9a-f]{40}$'

rev=$(jq -r '.nodes["nixpkgs-runner"].locked.rev' flake.lock)
[[ "$rev" =~ $REV_RE ]] || { echo "flake.lock's nixpkgs-runner rev is not a git sha: $rev" >&2; exit 1; }

version=$(nix eval --raw --impure --expr \
  "(import (builtins.getFlake \"github:NixOS/nixpkgs/$rev\") {}).github-runner.version")
[[ "$version" =~ $VERSION_RE ]] || { echo "github-runner.version did not look like a version: $version" >&2; exit 1; }

latest_version=$(gh api repos/actions/runner/releases/latest --jq .tag_name | sed 's/^v//')
[[ "$latest_version" =~ $VERSION_RE ]] || { echo "actions/runner latest release did not look like a version: $latest_version" >&2; exit 1; }

if [ "$version" = "$latest_version" ]; then
  echo "pinned github-runner $version is the latest release"
  exit 0
fi

latest_published_at=$(gh api repos/actions/runner/releases/latest --jq .published_at)
[ -n "$latest_published_at" ] || { echo "could not look up the latest release's publish date" >&2; exit 1; }

latest_published_epoch=$(date -d "$latest_published_at" +%s)
now_epoch=$(date +%s)
age_days=$(((now_epoch - latest_published_epoch) / 86400))

echo "pinned github-runner: $version, latest is $latest_version published $latest_published_at ($age_days day(s) ago)"

if [ "$age_days" -ge "$MARGIN_DAYS" ]; then
  echo "::error::github-runner $version is behind $latest_version, released $age_days day(s) ago; bump nixpkgs-runner before GitHub's 30-day window closes it" >&2
  exit 1
fi
