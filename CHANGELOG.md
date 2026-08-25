# Changelog

All notable changes to the Vega agent and the `vega` CLI are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.19.0] - 2026-08-25

### Added

- `VEGA_EXCLUDE` leaves matching store paths unpublished, as comma-separated
  globs over the path NAME (the part after the hash, so a pattern survives a
  rebuild): `VEGA_EXCLUDE='*.erofs'`. `VEGA_MAX_NAR_BYTES` does the same by size,
  as a blunt guard against an accidental multi-gigabyte push. Both are exposed on
  the Action as `exclude` and `max-nar-bytes`.

  This is for output no other machine can use. A host-specific microVM disk image
  is one to two gigabytes, changes whenever its guest config does, and nobody
  else will ever substitute it; on the deployment that asked for this, such paths
  were 40 of 49 publish minutes. An excluded path is neither uploaded nor
  attested, so it contributes to no tier, and anything referencing it leaves a
  consumer a dangling reference to build themselves. That is right for a
  host-specific artifact and wrong for anything another machine might want.

  Every skip is logged, with a count, the total NAR bytes and each path: a silent
  exclusion is indistinguishable from a cache that quietly lost paths. A pattern
  that matches nothing warns, as does excluding one of the build's own outputs,
  which forfeits its provenance. A malformed `VEGA_MAX_NAR_BYTES` fails the run
  rather than quietly reverting to no ceiling.

- The builder gives its store a free-space floor, so a build collects garbage
  instead of taking the host's disk to zero. The image shipped only a periodic
  GC, which runs between builds and therefore cannot help when one build cycle
  produces more garbage than the disk has headroom: on a shared host that ran to
  0 bytes free twice in a day, against roughly 49 GiB of collectable paths per
  cycle. Nix's own `min-free`/`max-free` collect during a build, and the
  entrypoint now writes both into the generated `nix.conf` and prints them at
  boot.
- `VEGA_MIN_FREE` and `VEGA_MAX_FREE` tune the floor, accepting a byte count or a
  binary suffix (`VEGA_MIN_FREE=25G`). `VEGA_MIN_FREE=0` disables it, and the
  boot line says so rather than leaving the operator to infer it. The defaults
  are a fraction of the store's filesystem (10% and 25%, floored at 1 GiB, capped
  at 25 GiB and 60 GiB), because a fixed size is wrong at both ends: 25 GiB on a
  20 GB runner would collect on every check, and 1 GiB on a large shared host is
  a rounding error against one build cycle.
- Booting against a mounted `/etc/nix/nix.conf` that sets no `min-free` warns.
  That file belongs to the operator and the entrypoint does not edit it, so the
  floor is theirs to set; the failure mode is a full host rather than a failed
  build, and it is invisible until it happens.

### Fixed

- `vega verify` checks whether Vega has withdrawn a binding. It verified the
  signature, the signed tree head and log inclusion, and never asked, so a path
  whose shared signature had been revoked still reported a clean pass, which is
  the one answer a verifier must not give. The revocation list is fetched from
  the cache origin (it is global, not per-tenant) and authenticated with the
  user's pinned shared key, never one the same cache served. A revoked binding
  now fails by every route, including the tenant and signature-only ones and the
  MCP risk gate an agent acts on, whatever key signed the build, since "Vega withdrew this" is a different
  answer rather than weaker evidence. A status that cannot be established is
  reported as unknown and is not treated as clean, so a cache that withholds the
  list is distinguishable from one with nothing to hide. The list carries a
  signed timestamp and total, both checked, so a stale replay or a truncated
  answer is unknown rather than clean.

## [0.18.0] - 2026-08-17

### Fixed

- A stalled NAR upload no longer consumes the whole job before a retry can run.
  The per-attempt deadline was a wall-clock allowance scaled to the payload, so a
  5 GB NAR was given roughly 85 minutes and a wedged connection sat there for the
  better part of it: two multi-GB uploads went 50 and 88 minutes without moving,
  and the 90 minute step cap killed the job before any retry. An upload is now
  bounded by INACTIVITY instead: the clock restarts on every chunk that leaves the
  process and once more when the body ends, so a silent upload fails in five
  minutes and retries, while a slow but progressing one runs as long as it needs.
  That distinction is the point. A fixed cap cannot make it, and shortening the
  old allowance would have aborted large uploads that were working, since a
  presigned PUT is not resumable and every retry restarts from zero.

### Added

- Stall warnings report bytes transferred and the current rate per path
  (`upload /nix/store/... (5293s in stage, 350 MiB/5.0 GiB, 0 B/s)`), so a wedged
  upload and a slow one are distinguishable from the job log alone. Reading
  progress is possible because the request body is wrapped to count bytes as they
  are read; it stays a sized Blob, so the presigned PUT still sends Content-Length
  rather than switching to chunked encoding.

### Changed

- `VEGA_UPLOAD_STALL_SECONDS` (default 300) sets how long an upload may move no
  bytes before it is aborted and retried.
- `VEGA_UPLOAD_TIMEOUT_SECONDS` no longer has any effect. It used to be a floor
  the payload-scaled allowance was raised from, and there is no longer such an
  allowance. An absolute per-attempt cap is available as `VEGA_UPLOAD_CAP_SECONDS`
  and defaults to off, because any fixed cap eventually aborts a large upload that
  is progressing normally. The new name is deliberate: reusing the old one would
  have turned an existing `1800` into a hard 30 minute kill that no multi-GB
  upload could survive, where being ignored leaves the safe default in place.

## [0.17.3] - 2026-08-16

### Fixed

- The publish crashed at the very end, after the build and most paths had already
  uploaded, on a large closure. The per-attempt upload deadline scales with the
  payload as `(bytes / MiB) * 1000`, which is a float for any NAR that is not a
  whole number of mebibytes, and `AbortSignal.timeout` throws `ERR_OUT_OF_RANGE`
  ("delay ... must be an integer") on a fraction. A roughly 1.9 GB NAR produced a
  deadline near 1859098.75 ms and the job exited 1 every time, so a self-hosted
  runner went permanently red even though the build was fine and the cache
  converged on resume. The deadline is now rounded up where every request deadline
  is applied, so no computed timeout can reach the timer as a fraction. The value
  itself is correct: a multi-GB PUT is given at least payload-size seconds at an
  assumed 1 MiB/s so a slow but progressing upload is not aborted.

## [0.17.2] - 2026-08-16

### Changed

- `@noble/curves` moved from 1.x to 2.3.0. The 2.x line renamed the subpath
  export, so the Ed25519 import is now `@noble/curves/ed25519.js`. The signing
  API (`getPublicKey`, `sign`, `verify`) is unchanged, and 1.x and 2.x produce
  byte-identical public keys and signatures for the same key and message and
  cross-verify each other, so every existing signature still verifies and the
  trust root is unaffected.

## [0.17.1] - 2026-08-16

### Fixed

- The builder image shipped github-runner 2.334.0, which GitHub deprecated
  server-side. A deprecated runner is refused before it can self-update and, in
  the read-only Nix store, cannot update in place, so every deployed builder went
  offline at once on GitHub's schedule (the listener connected, was told the
  version is deprecated, exited, and the container restart-looped), and queued
  jobs waited indefinitely. The runner is now github-runner 2.336.0. Pull the new
  image and recreate the container; the builder image version tracks the agent
  version, so the fixed image is 0.17.1 (the line moved from 0.16.x to 0.17.x when
  the agent did).
- For anyone still on a pre-0.16.0 image, upgrading also carries the 0.16.0 boot
  seed and closure registration (`nix-seed` and the store load-db), which ended
  the separate "runner binaries are gone" restart churn where the in-container GC
  collected reseeded store paths the runner needed.

### Changed

- The GitHub Actions runner is pinned through a separate `nixpkgs-runner` flake
  input, advanceable on its own so a server-side runner deprecation is a one-input
  bump and a patch release rather than a full toolchain move. GitHub sets that
  schedule, not us, so the runner pin is kept current independently of the rest of
  the image.
- The boot shim reseeds a persistent `/nix` volume whenever the baked closure
  changed, not only when the entrypoint symlink dangles. A release that changes a
  store path the entrypoint does not depend on (this one bumps the runner while the
  entrypoint is byte-identical) left an older volume resolving the entrypoint but
  missing the new runner, so the shim handed off and the preflight then refused to
  boot: the upgrade re-bricked on a volume deployment. The fast path now also
  requires the closure root and the runner present, so any changed path triggers
  the additive reseed and a volume deployment self-heals on pull like a fresh one.

## [0.17.0] - 2026-08-13

### Added

- After a successful publish, the CI agent and `vega push` print the exact
  `extra-substituters` and `extra-trusted-public-keys` lines a host needs to
  consume the tenant's builds. The bare control-plane URL answers Nix's
  `/nix-cache-info` probe with 200 (it is the shared-tier cache) while serving
  no tenant path, so a substituter pointed at the root was indistinguishable
  from a cold cache; one deployment rebuilt its full closure on every CI run
  for ten days before anyone could tell. Both server-supplied values are
  shape-checked before they are printed.
- `vega doctor` and `vega report` warn when the local nix configuration trusts
  a Vega tenant key but no `/tenant/` or `/u/` substituter can serve its paths,
  which is the exact shape of that misconfiguration.

### Fixed

- The per-architecture image push in the release workflow retries: GHCR loses
  the blob-upload race when both architecture legs push overlapping blobs
  concurrently, which failed the first v0.16.0 publish attempt with
  "unknown blob".

## [0.16.0] - 2026-08-13

### Added

- `vega report` composes a problem report and prints a prefilled GitHub issue
  URL. It carries what makes a report answerable, the agent version, the
  platform, the control plane, the credential's state and the doctor checks, and
  never the enrolled login, the environment, any config file or logs. `--hash`
  adds an output and its public verdict, `--error` quotes text you pass. Nothing
  is sent by the command: it ends at a URL you open, read and edit.
- A dispatched reproduction that fails now reports the failure to the control
  plane, so a candidate whose provenance cannot name its output is retired
  rather than re-dispatched on a cooldown for ever. Inert until the reproducer
  workflow passes the candidate hash.
- The builder boot shim attests the fast path as well as the healing one, so
  both routes leave a record.
- The builder image is published for `aarch64-linux` as well as `x86_64-linux`,
  as a manifest list, so a donor on ARM hardware has an image to run. Each
  architecture builds natively and is signed, and the list is assembled from
  those signed digests and signed itself.

### Changed

- `vega doctor`'s checks moved into one function that `vega report` also calls,
  so the two cannot disagree about the state of a machine.
- The publish output names each path unambiguously, and the substituter and
  timeout guidance in the scaffolded config matches what the action reads.

### Fixed

- `vega doctor` and `vega report` no longer hang on an unreachable control
  plane: the reachability probe has a deadline, which matters most when the
  control plane is the thing being reported.
- The flake wrapper changed directory into the Nix store, so `vega push`, `vega
  init`, `vega gate` and `vega diff` resolved paths against the store rather
  than where you ran them. Present since 0.13.0 for anyone installing with `nix
  run` or `nix profile`.

## [0.13.0] - 2026-07-16

### Fixed

- `vega verify`, and the MCP `vega_risk` and `vega_assess_change` tools, scanned
  the transparency log oldest-first. Once the log grew past the scan cap a
  recently promoted build was reported as absent and denied. The scan now runs
  newest-first, so a valid build is found regardless of the log's size.
- A NAR download that failed mid-stream raised an unhandled error that terminated
  the process, including the long-lived `vega mcp` server. The decompression now
  surfaces the failure as a normal error, reported as "not checked" rather than a
  false hash mismatch.
- A reproduction of a long build minted a single OIDC token up front and then
  failed at upload with a 401 once it expired. The reproducer now re-mints the
  token on demand, matching the build agent.
- `vega verify --no-nar` no longer states that the bytes match when the NAR check
  was skipped.
- `vega dashboard` now prints the sign-in URL.
- `vega init` scaffolds the current agent action pin instead of a stale one.

### Changed

- `vega verify` fetches now apply a timeout, bound the response size and retry a
  transient failure, matching the MCP path.
- `vega_reproduce` reports its evidence tier as origin-asserted, distinguishing it
  from the signature-grounded `vega_verify`, `vega_risk` and `vega_assess_change`.
- The agent derives path-info hashes in process instead of running `nix hash
  convert` once per closure path, so a large closure no longer risks exhausting
  file descriptors.

### Security

- The reusable reproduce workflow rejects a runner label that is not a known
  GitHub-hosted runner, so a caller cannot steer a signing-gate reproduction onto
  other hardware.
- The reproducer validates the flake attribute it is asked to build, and the cache
  agent removes the OIDC minting credential from the environment before evaluating
  any flake.
- The builder image registers a Nix garbage-collection root for its own runtime
  closure, so the in-container store GC can no longer delete the entrypoint and
  leave the container unable to start.

## [0.12.0] - 2026-06-22

### Added

- The builder image garbage-collects its Nix store on a schedule, so a long-lived
  self-hosted runner's `/nix` no longer grows without bound. The entrypoint runs
  `nix-collect-garbage --delete-older-than 7d` in the background (it honors the
  store GC lock and in-flight build temproots, so it never deletes a path a
  running build needs). On by default; opt out with `VEGA_GC` set to `false`, `0`,
  `off` or `no` (case-insensitive). Tunable via `VEGA_GC_DELETE_OLDER_THAN`
  (default `7d`), `VEGA_GC_INTERVAL` (default `7d`) and `VEGA_GC_INITIAL_DELAY`
  (default `1h`); an ephemeral runner skips it.

## [0.11.0] - 2026-06-22

### Added

- A build of a flake that lives in a repository subdirectory is now reproducible.
  The agent records the subdirectory as the attestation's `dir`, and the
  reproducer rebuilds it as `github:<owner>/<repo>/<rev>?dir=<dir>#<attr>`. The
  subdirectory is only honored on a canonical github reference with an immutable
  commit SHA, is sanitized to a relative subpath, and the reproducer rejects any
  symlinked path component so a committed symlink cannot escape the pinned tree.
  Previously such a build was treated as foreign and stayed at the tenant tier.

### Changed

- The foreign-installable warning now fires only for a flake that is genuinely
  not the repository's own (another repository, nixpkgs, or a path outside the
  checkout), not for the repository's own subdirectory flake.

## [0.10.0] - 2026-06-20

### Changed

- The builder image auto-detects the Nix build sandbox (`VEGA_NIX_SANDBOX`,
  default `auto`). At startup the entrypoint builds a throwaway derivation under
  the real sandbox to learn whether the container can create the user namespace
  the sandbox needs; on success it sets `sandbox = true`, otherwise it falls back
  to `sandbox = relaxed` with a warning. `VEGA_NIX_SANDBOX=true` requires the
  sandbox and exits if it cannot start (so a build asked to be isolated never
  runs unsandboxed by surprise); `false` opts out. An operator-mounted
  `/etc/nix/nix.conf` is not rewritten, but `VEGA_NIX_SANDBOX=true` still holds
  its contract there (the container exits unless the mounted config's effective
  `sandbox` is `true` and `sandbox-fallback` is `false`). Previously the sandbox
  was off unless `VEGA_NIX_SANDBOX=true` was set by hand. The probe and the
  written config set `sandbox-fallback = false`, so a build that cannot be
  sandboxed fails rather than silently running unsandboxed (without this, Nix's
  default fallback let the sandbox "succeed" without real isolation).
- The builder image registers its baked store closure (`nix-store --load-db`)
  at startup, so a sandboxed build can mount each input's full closure. Without
  it a `sandbox = true` build failed because the builder's interpreter (glibc)
  was not in the store database and so was not mounted into the sandbox
  (`bash: No such file or directory`).

## [0.9.0] - 2026-06-20

### Added

- `vega init` scaffolds a complete `.github/workflows/vega-cache.yml` into a
  repository, so a new user goes from install to a first attested CI build in one
  command. The generated workflow pins every action to a full commit SHA (a moved
  tag is the vector behind recent GitHub Actions supply-chain compromises, and a
  SHA is immutable), requests least-privilege permissions, sets
  `persist-credentials: false`, and never runs on `pull_request`. Flags:
  `--attr`, `--dir`, `--force`, `--print`, `--json`. The same recipe is published
  at `examples/vega-cache.yml`; a test asserts the two cannot drift.

## [0.8.0] - 2026-06-10

### Added

- `vega doctor --json` emits the structured checks (`{ ok, checks }`), so the only
  query command that lacked `--json` now matches its peers for scripting/CI.
- `vega login --url <url>` is the control-plane flag, matching `verify`/`assess`/
  `mcp`; `--control-plane` stays as an alias.
- `vega trust add --flake <owner/repo>` / `--org <owner>` scope a build-trust edge
  to a flake or org. Unlike `--package` (which matches the builder-controlled
  store-path name), these match only a build with a verified github-hosted CI
  attestation from that flake/org, so a build without one is not covered.
- `vega trust add --accept-unreproducible` opts a single edge into serving a
  builder's binding that Vega's own reproducer diverged from. Off by default (such
  a binding is withheld); the flag prints a risk line and is the explicit,
  revocable consent to accept it.

### Changed

- `vega_assess_change` now caps a single in-flight NAR fetch (20s) in addition to
  its path cap and wall-clock budget, so one slow NAR cannot overrun the budget by
  the full default timeout. `verifyNar` accepts an optional per-call timeout.

### Fixed

- NAR upload re-mints the presigned URL and retries once when a large NAR outran
  the presign window (R2 returns 403 on the expired URL). A 403 within the window
  (auth, checksum, object error) still propagates, so a real failure is not masked.
  This is the agent side of the multi-GB upload fix; the cache side raised the
  presign TTL to six hours.

## [0.7.0] - 2026-06-09

### Added

- `vega assess` and the `vega_assess_change` MCP tool: a read-only, change-level
  trust gate. Given the store paths a change ADDS (already resolved, e.g. piped
  from `vega gate --json`), it rolls each path's proof-backed verdict up into one
  `allow`/`warn`/`deny` for the whole change, with a per-path breakdown. It
  resolves and builds nothing. The MCP tool is bounded (a path cap plus a
  wall-clock budget), so one call cannot monopolize the server; a change it could
  not assess in full is reported as truncated and is never `allow`.
- A shared verdict envelope (`vega.verdict.v1`): `schemaVersion`, `tool`,
  `target`, `verdict`, `reasonCodes`, `nextActions`, and a tool-specific
  `evidence` payload, so a consumer can branch on a stable shape.

### Changed

- The NAR re-hash now reports three states (`verified`, `mismatch`, `unchecked`)
  instead of a single boolean. A byte check that could not run (a compression we
  cannot decompress locally, e.g. an upstream `xz` mirror) is `unchecked`, which
  is distinct from a proven `mismatch`: only a mismatch denies, `unchecked` never
  reads as verified, and `vega_risk` no longer reports a valid upstream mirror as
  a hash mismatch. For an upstream mirror an unchecked NAR stays `allow` with a
  `NAR_NOT_LOCALLY_CHECKED` disclosure (nix re-checks the hash on substitution);
  for the shared tier it warns.

## [0.6.0] - 2026-06-08

### Added

- `vega gate <installable>` — a dependency-closure supply-chain gate. It builds
  an installable, computes its closure, and compares it against a committed
  `vega-closure.lock` baseline, emitting `allow`/`warn`/`deny` (exit non-zero on
  `deny`) for CI. The size signal is added bytes as a fraction of the baseline so
  a removal cannot mask a new dependency; `--update` writes the baseline;
  thresholds are flag-configurable. `--json` emits the structured verdict.
- `vega_reproduce` adds reproducibility to the MCP surface: a read-only tool that
  queries the cache's recorded reproduction status (`reproducible`,
  `uncorroborated`, `mirrored`, `diverged`, `unknown`) with the count of agreeing
  builders. It never rebuilds, suggesting `vega diff` for a local check instead.
  Parsing fails closed on malformed input.

## [0.5.0] - 2026-06-07

### Added

- `vega diff <installable>` checks whether a flake output reproduces on the
  machine you run it on. It rebuilds the output and, on a mismatch, runs
  diffoscope and names the likely cause and its standard fix using the same
  diagnosis taxonomy the cache uses server-side. Exits non-zero when the output
  does not reproduce, so it works as a CI gate; `--json` emits the structured
  verdict.
- Client-side secret scanning before publish. The agent scans each build's own
  output for recognizable credentials (private keys, cloud and service tokens)
  and warns before upload, since a path published to the cache cannot be
  unpublished. Detection is by specific format, not entropy, so it ignores the
  base32 store hashes that fill a NAR. On by default; disable with
  `secret-scan: false` in `vega.yaml`.
- `extra-substituters` / `extra-trusted-public-keys` action inputs: pull heavy
  dependencies from a trusted upstream cache (e.g. a project's Cachix) instead of
  building them from source.

### Changed

- The agent no longer enforces its own build timeout by default. A build's only
  time limit is the CI job's `timeout-minutes`, so a long-but-progressing build
  is never SIGTERM-killed (which discarded all completed store paths and made
  Vega look broken on heavy closures). Opt into an explicit per-build cap with
  the new `build-timeout-minutes` action input (default `0`, disabled).
- The agent warns when a build it attests is not the running repository's own
  flake (a foreign installable, a path outside the checkout, or a
  `github:owner/repo?dir=sub` subflake). The cache records reproduction
  provenance from the repository, so such a candidate cannot be reproduced and
  stays at tenant tier.

### Fixed

- `privacy.continent: false` is now honored. The flag was parsed but never sent,
  so the control plane always derived and stored a build's continent. The agent
  now transmits the opt-out and the server records the continent as unknown.

## [0.4.3] - 2026-06-03

### Fixed

- `vega verify` and `vega mcp` now retry a transient server error (HTTP 5xx)
  from the cache, with bounded exponential backoff, before reporting a failure.
  A single transient 5xx (for example a momentary Durable Object error on a
  heavily-written endpoint such as `/log/entry`) previously failed the entire
  verification, which surfaced as `vega mcp` reporting an error on a build that
  is in fact verifiable. A 2xx, 3xx, or 4xx response is a definitive answer and
  is never retried (a 404 means "no such build"). Affects read-only,
  idempotent GETs only.

## [0.2.0] - 2026-06-01

### Added

- `vega verify <store-path>`: independent verification of a build — checks the
  cache's signature against a key you already trust, the signed RFC 9162
  transparency-log tree head, the build's inclusion proof, and re-derives the NAR
  hash. Proof, not trust.
- `vega mcp`: a read-only [Model Context Protocol](https://modelcontextprotocol.io)
  server exposing `vega_verify` and `vega_risk` (an allow/warn/deny gate with
  proof-backed reason codes) to AI coding agents.
- `vega.yaml`: `include`/`exclude` attribute matchers (Garnix-style globs),
  `devShells` (cache dev environments so `nix develop` substitutes), and
  `reuse-cache` (substitute this repo's prior pushes before building).
- `vega doctor`: an on-demand check for a newer published release.
- Branded "Vega" check runs on contributor commits (via the Vega GitHub App).
- An animated brand splash on bare `vega`.

### Fixed

- The GitHub OIDC token is now minted on demand, so a long build no longer fails
  with `upload-url: 401` when the token expires before the push.

### Security

- The MCP server is read-only, sanitizes every cache-reported string before it
  enters an agent's context (OWASP LLM01/LLM05), takes its trust anchor from
  `nix.conf` (never the cache), and bounds the transparency-log scan, response
  bodies, and stdin frames. Reviewed against the OWASP Top 10 for LLM
  Applications and the MCP security guidance.

[Unreleased]: https://github.com/Ad-Astra-Computing/vega-agent/compare/v0.16.0...HEAD
[0.16.0]: https://github.com/Ad-Astra-Computing/vega-agent/releases/tag/v0.16.0
[0.12.0]: https://github.com/Ad-Astra-Computing/vega-agent/releases/tag/v0.12.0
[0.11.0]: https://github.com/Ad-Astra-Computing/vega-agent/releases/tag/v0.11.0
[0.10.0]: https://github.com/Ad-Astra-Computing/vega-agent/releases/tag/v0.10.0
[0.9.0]: https://github.com/Ad-Astra-Computing/vega-agent/releases/tag/v0.9.0
[0.8.0]: https://github.com/Ad-Astra-Computing/vega-agent/releases/tag/v0.8.0
[0.2.0]: https://github.com/Ad-Astra-Computing/vega-agent/releases/tag/v0.2.0
