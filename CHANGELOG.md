# Changelog

All notable changes to the Vega agent and the `vega` CLI are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Ad-Astra-Computing/vega-agent/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Ad-Astra-Computing/vega-agent/releases/tag/v0.2.0
