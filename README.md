# vega-agent

The client side of Vega, a reproducible-build Nix binary cache. This repository
holds the agent that builds a flake and attests its outputs, and the reproducer
that rebuilds someone else's derivation to corroborate it.

Vega signs a build into its shared cache only after independent builders rebuild
the same derivation and produce the same output, and it records every
attestation in a public, append-only transparency log. The control plane that
enforces that is separate; it is documented at https://docs.vega-cache.dev. This
repository is public on purpose: the code that builds and attests should be
auditable by anyone who relies on the result.

## The `vega` CLI

`vega` is the command line for the cache: enroll a machine, push your local
builds to your own namespace, and manage who your machines trust. Run it with
Nix, no clone needed:

```
nix run github:Ad-Astra-Computing/vega-agent#vega -- login
nix profile install github:Ad-Astra-Computing/vega-agent#vega   # or install it
```

Or add it to your flake, pinned to a release tag for repeatable builds:

```nix
inputs.vega.url = "github:Ad-Astra-Computing/vega-agent/v0.6.0";
# optional, to share this flake's nixpkgs:
#   inputs.vega.inputs.nixpkgs.follows = "nixpkgs";
```

Then put it on `PATH` via `vega.packages.${system}.default` (devShells,
`environment.systemPackages`, `home.packages`, ...) or run it with
`nix run vega#vega -- verify ...`.

Quickstart:

```
vega login                  # enroll this machine (GitHub device flow)
vega push .#my-package      # build locally, upload novel paths to your namespace
vega verify /nix/store/<h>  # independently verify a build: signature + transparency log + NAR bytes
vega diff .#my-package      # rebuild locally and check reproducibility; explain any divergence
vega gate .#my-package      # gate CI on the dependency-closure delta vs a committed baseline
vega assess --added-paths - # gate a change's added store paths on their trust standing (read-only)
vega mcp                    # read-only MCP server for AI agents (verify, risk, reproduce, assess_change)
vega view                   # print the nix.conf substituter + keys for your view
vega trust add github:alice # trust a builder (scoped --package/--flake/--org, revocable)
vega status                 # auth + connectivity
vega doctor                 # diagnose nix / zstd / auth, and check for a newer release
```

`vega verify` checks the cache's signature against a key you already trust, the
signed tree head, the build's RFC 9162 inclusion proof, and re-derives the NAR
hash — proof, not trust. `vega diff` rebuilds locally and tells you whether a
build is reproducible, naming the cause of any divergence. `vega gate` builds an
installable, diffs its dependency closure against a committed `vega-closure.lock`
baseline, and emits `allow`/`warn`/`deny`, exiting non-zero on `deny`, so CI can
gate on what a change adds to the dependency closure: new store paths warn, and
crossing your configured thresholds (added size or path count) denies. `vega
assess` takes the store paths a change adds (already resolved, e.g. piped from
`vega gate --json`) and rolls each path's proof-backed verdict up into one
`allow`/`warn`/`deny` for the whole change, with a per-path breakdown; it is
read-only and builds nothing. `vega mcp` exposes verification, the
`allow`/`warn`/`deny` risk gate, the read-only reproduction-status query, and the
change-level `assess_change` gate to coding agents over the Model Context
Protocol, so an agent can check a dependency before installing it.

Full command set: `login`, `logout`, `whoami`, `status`, `doctor`, `push`,
`verify`, `diff`, `gate`, `assess`, `mcp`, `trust` (`add`/`remove`/`list`),
`view`; run `vega <command> --help` for details.
The GitHub token from `login` is used once and never stored; only a short-lived
Vega credential is kept (`~/.config/vega/credential`, mode 0600), and the control
plane is required to be https.

## Layout

- `agent/` holds the Node CLIs and a composite GitHub Action.
  - `main.ts` builds an installable and attests its outputs.
  - `reproduce.ts` rebuilds a derivation from its provenance and attests the result.
  - `nix.ts` is the boundary that shells out to the `nix` CLI.
  - `verify.ts` re-derives a NAR hash to audit a published cache entry.
- `src/agent/` is the protocol and payload logic, with no I/O, covered by tests.
- `src/nix/` holds Nix wire-format helpers: narinfo, store paths, hashing.
- `.github/workflows/reproduce.yml` is the reusable reproduction workflow.

## Attesting your own builds

Call the composite action from a workflow that grants OIDC. Pin actions to a
commit SHA rather than a tag.

```yaml
permissions:
  id-token: write
  contents: read
steps:
  - uses: actions/checkout@<sha>
  - uses: Ad-Astra-Computing/vega-agent/agent@<sha>
    with:
      installable: .#packages.x86_64-linux.default
      control-plane: https://vega-cache.dev
```

Useful action inputs:

- `skip-upstream: "true"` — upload only paths the upstream cache does not already
  serve (recommended for system closures).
- `reuse-cache: "true"` — substitute this repo's own prior Vega pushes before
  building, so heavy paths are not rebuilt every run. Keep it **off** for any job
  whose attestation feeds the shared tier (that build must stay independent of Vega).
- `build-timeout-minutes` — explicit per-build cap. Default `0` (disabled): the
  job's `timeout-minutes` is the only limit, so a long-but-progressing build is
  never killed.
- `extra-substituters` / `extra-trusted-public-keys` — pull heavy dependencies
  from a trusted upstream cache (e.g. a project's Cachix) instead of from source.

## Reproducing another build

Run the reproduce workflow against a build's provenance: the flake reference, the
attribute, and the locked revision. It rebuilds on a fresh runner under this
repository's identity and attests the result. Agreement on the output is what
promotes it to the shared cache; a mismatch is recorded as a divergence.

Reproduction is meant to be distributed. Running every build in one repository
both queues the jobs behind a single concurrency pool and defeats the point:
independence comes from distinct builders. Run the reproducer in your own
repository, where it counts as a separate, independent corroboration.

## Security

The reproducer builds code it did not write. Before invoking nix, the agent
removes the GitHub OIDC request token from the environment, so the untrusted
build cannot mint a runner-identity token. Flakes evaluate in pure mode and
builds run in the nix sandbox, so the build cannot read the attestation
credential either. The control-plane URL is fixed in the workflow, not an input,
so a caller cannot redirect the token. A self-hosted reproducer must still use
ephemeral, per-job-isolated runners, never a long-lived host.

## Run with Nix

```
nix run github:Ad-Astra-Computing/vega-agent            # the vega CLI (default)
nix run github:Ad-Astra-Computing/vega-agent#vega -- login
nix run github:Ad-Astra-Computing/vega-agent#attest      # build and attest (CI)
nix run github:Ad-Astra-Computing/vega-agent#reproduce   # reproduce and attest (CI)
nix develop                                              # a shell with node and zstd
```

The `attest` and `reproduce` apps read their inputs from the environment, the
same variables the GitHub Action and the reproduce workflow set.

## Development

```
npm install
npm run typecheck
npm test
```

## License

BSD 3-Clause; see [LICENSE](LICENSE). This repository began from the
open-sourced garnix CI codebase (Copyright garnix, Co.). New code is Copyright
Ad Astra Computing Inc.
