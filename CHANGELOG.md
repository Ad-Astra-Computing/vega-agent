# Changelog

All notable changes to the Vega agent and the `vega` CLI are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
