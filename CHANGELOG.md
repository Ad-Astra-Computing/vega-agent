# Changelog

All notable changes to the Vega agent and the `vega` CLI are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Ad-Astra-Computing/vega-agent/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/Ad-Astra-Computing/vega-agent/releases/tag/v0.10.0
[0.9.0]: https://github.com/Ad-Astra-Computing/vega-agent/releases/tag/v0.9.0
[0.8.0]: https://github.com/Ad-Astra-Computing/vega-agent/releases/tag/v0.8.0
[0.2.0]: https://github.com/Ad-Astra-Computing/vega-agent/releases/tag/v0.2.0
