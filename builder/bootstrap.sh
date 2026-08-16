#!/bin/busybox sh
# Boot shim for the Vega builder image. Runs BEFORE anything in /nix/store, on
# a static busybox shipped as a real file, so it works even when a persistent
# /nix volume masks the image's store (the named-volume upgrade failure:
# Docker seeds a volume from the image only when the volume is empty, so after
# an image update the old store masks the new one and every /bin symlink into
# it dangles; see the README's volume notes).
#
# Fast path: the whole baked closure is present, so /nix is the image's own
# store or an already-seeded volume. Exec the entrypoint directly; no copying,
# no overhead.
#
# Heal path: the entrypoint symlink dangles. Seed the baked store copy
# (/nix-seed/store, a duplicate of the image's /nix/store living OUTSIDE /nix
# precisely so a volume cannot mask it) into the volume additively: an
# existing store path is skipped wholesale, so store paths already in the
# volume, the Nix database and gcroots are untouched. The real entrypoint then
# registers the seeded paths in the database at boot (nix-store --load-db) and
# its preflight verifies the closure before the runner accepts jobs.
set -eu

real="/bin/vega-builder-entrypoint"
# Every non-builtin runs through the multiplexer binary DIRECTLY. In the heal
# scenario PATH (/bin) is full of symlinks into the masked store, so a bare
# `mkdir` or `cp` would resolve to a dangling link and die "not found" before
# any labeled diagnosis. Only [ , echo and exec are ash builtins.
bb="/bin/busybox"

# test -e follows symlinks: false for a dangling link. The line is the fast
# path's positive attestation: without it a healthy boot and an inert shim
# look identical in the log, and a mechanism observable only when it fires
# cannot be trusted from the outside.
#
# The check is the whole closure, not just the entrypoint. A release can change
# a store path the entrypoint does NOT depend on (this one bumps the runner off
# a separate pin while the entrypoint stays byte-identical), and then an old
# volume still resolves the entrypoint while the new runner is absent. An
# entrypoint-only fast path would hand off to a store missing the new runner and
# the preflight would refuse to boot: a silent re-brick on the very upgrade meant
# to fix one. VEGA_BUILDER_ROOT is the buildEnv over the ENTIRE baked closure, so
# its path changes whenever anything in the image does; requiring it (and the
# runner explicitly) present means any changed path forces the additive reseed
# below. Defaulting an unset var to a nonexistent path just routes to the safe
# seed path rather than trusting an incomplete store.
if [ -e "$real" ] && [ -e "${VEGA_BUILDER_ROOT:-/nonexistent}" ] && [ -e "${RUNNER_DIST:-/nonexistent}" ]; then
  echo "vega-builder: boot shim: store complete, direct handoff" >&2 || true
  exec "$real" "$@"
fi

if [ ! -d /nix-seed/store ]; then
  echo "vega-builder: FATAL: ${real} does not resolve and the image has no /nix-seed to heal from. The /nix mount is masking the image's store." >&2
  exit 64
fi

echo "vega-builder: /nix does not contain this image's store (a persistent volume from an older image is mounted); seeding the baked store copy" >&2 || true
failed=0
"$bb" mkdir -p /nix/store || failed=1
# Copy per store path, not one recursive copy of the seed root: busybox cp -n
# skips an EXISTING DESTINATION DIRECTORY wholesale (it does not merge like
# GNU cp), so a single recursive copy into the existing /nix/store would copy
# nothing. Store paths are immutable, so whole-path granularity is also the
# right semantics: an existing path is skipped untouched, a missing one is
# copied completely. Failures are collected, never fatal mid-loop, so the
# labeled diagnosis below is always reached.
# The -L checks guard the -e follow-symlink semantics: a store path that is
# itself a symlink (none in today's closure, but legal) must count as present.
for p in /nix-seed/store/*; do
  [ -e "$p" ] || [ -L "$p" ] || continue
  if [ ! -e "/nix/store/${p##*/}" ] && [ ! -L "/nix/store/${p##*/}" ]; then
    "$bb" cp -a "$p" /nix/store/ || failed=1
  fi
done

# A copy failure is fatal even when the entrypoint itself resolves. In the
# changed-closure shape the entrypoint was present all along, so a check of only
# $real would hand off on a half-seeded store (a runner copy that hit a full
# disk) and lose this diagnosis to the entrypoint's generic preflight. When
# seeding succeeds the full closure was copied, so $real resolving then means the
# store is complete.
if [ "$failed" -ne 0 ]; then
  echo "vega-builder: FATAL: seeding failed (read-only /nix, or the disk is full); the store is incomplete." >&2
  exit 64
fi

if [ ! -e "$real" ]; then
  echo "vega-builder: FATAL: seeding did not make ${real} resolve; the /nix mount is not a usable store." >&2
  exit 64
fi

exec "$real" "$@"
