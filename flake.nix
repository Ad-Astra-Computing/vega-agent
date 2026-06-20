{
  description = "Vega: the `vega` CLI plus the build agent and reproducer for the Vega binary cache.";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (
        system: pkgs:
        let
          # Node 24 (active LTS) is the supported runtime; pin it rather than
          # tracking nixpkgs' default `nodejs`.
          nodejs = pkgs.nodejs_24;
          agent = pkgs.buildNpmPackage (finalAttrs: {
            pname = "vega-agent";
            version = "0.9.0";
            src = ./.;
            inherit nodejs;
            npmDeps = pkgs.importNpmLock { npmRoot = finalAttrs.src; };
            npmConfigHook = pkgs.importNpmLock.npmConfigHook;
            # No compile step: `tsx` runs the TypeScript directly at runtime.
            dontNpmBuild = true;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            installPhase = ''
              runHook preInstall
              # Ship only the runtime closure: drop dev tooling (typescript,
              # vitest, ...) so the package stays small and its surface minimal.
              # `tsx` is a runtime dependency (the wrappers execute through it).
              npm prune --omit=dev --offline --no-audit --no-fund

              mkdir -p "$out/lib/vega-agent" "$out/bin"
              cp -r agent cli src package.json node_modules "$out/lib/vega-agent/"

              # The CI agent bins (build+attest, reproduce). zstd on PATH for NAR
              # compression; the runner's own `nix` is inherited.
              for pair in attest:main reproduce:reproduce; do
                bin="vega-''${pair%%:*}"
                script="agent/''${pair##*:}.ts"
                makeWrapper ${nodejs}/bin/node "$out/bin/$bin" \
                  --add-flags "--import tsx $out/lib/vega-agent/$script" \
                  --chdir "$out/lib/vega-agent" \
                  --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.zstd ]}
              done

              # The user-facing `vega` CLI.
              makeWrapper ${nodejs}/bin/node "$out/bin/vega" \
                --add-flags "--import tsx $out/lib/vega-agent/cli/main.ts" \
                --chdir "$out/lib/vega-agent" \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.zstd ]}
              runHook postInstall
            '';
            meta = {
              description = "The Vega binary-cache CLI (login, push, trust, view) and its build agent.";
              homepage = "https://github.com/Ad-Astra-Computing/vega-agent";
              license = pkgs.lib.licenses.bsd3;
              mainProgram = "vega";
              platforms = pkgs.lib.platforms.unix;
            };
          });
          # The Vega builder image (Phase 1: runner mode). A reproducible OCI
          # image built with Nix (so its digest is stable and cosign-signing is
          # meaningful), containing nix, the GitHub Actions runner, and the vega
          # agent. See docs/builder-fleet.md. Linux only (OCI images are Linux).
          # Node 24 only (latest LTS): GitHub's runtime migration supports node24,
          # so the runner does not need the EOL/insecure node20. Every action in
          # the cached repo's workflow must be node24-capable (actions/checkout@v5+,
          # etc.). Bound once so the image contents and RUNNER_DIST are the SAME
          # derivation (otherwise the default node20 runner sneaks back in).
          githubRunner = pkgs.github-runner.override { nodeRuntimes = [ "node24" ]; };
          entrypoint = pkgs.writeShellApplication {
            name = "vega-builder-entrypoint";
            runtimeInputs = [
              pkgs.bashInteractive
              pkgs.coreutils
              pkgs.curl
              pkgs.jq
              pkgs.gnugrep
              pkgs.hostname
            ];
            text = builtins.readFile ./builder/entrypoint.sh;
          };
          builderRoot = pkgs.buildEnv {
            name = "vega-builder-root";
            paths = [
              agent
              pkgs.nix
              githubRunner
              pkgs.iana-etc
              pkgs.cacert
              pkgs.bashInteractive
              pkgs.coreutils
              pkgs.curl
              pkgs.jq
              pkgs.git
              pkgs.gnutar
              pkgs.gzip
              pkgs.xz
              pkgs.zstd
              pkgs.gnugrep
              pkgs.gnused
              pkgs.findutils
              pkgs.hostname
              pkgs.openssh
              entrypoint
              pkgs.dockerTools.fakeNss
            ];
            pathsToLink = [ "/bin" "/etc" ];
          };
          builderImage = pkgs.dockerTools.buildLayeredImage {
            name = "vega-builder";
            # No `created` (defaults to epoch) so the digest stays reproducible.
            tag = agent.version;
            contents = [ builderRoot ];
            # /tmp and the runner's writable home, created in the image.
            extraCommands = ''
              mkdir -p tmp home/runner
              chmod 1777 tmp
            '';
            config = {
              Entrypoint = [ "/bin/vega-builder-entrypoint" ];
              Env = [
                "PATH=/bin"
                "HOME=/home/runner"
                "USER=runner"
                "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                "NIX_SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                "RUNNER_DIST=${githubRunner}"
                "VEGA_BUILDER_VERSION=${agent.version}"
              ];
              Labels = {
                "org.opencontainers.image.title" = "Vega builder";
                "org.opencontainers.image.description" =
                  "Reproducible Nix builder for the Vega binary cache: a self-hosted GitHub Actions runner (runner mode) and a reproduction worker (donate mode).";
                "org.opencontainers.image.version" = agent.version;
                "org.opencontainers.image.vendor" = "Ad Astra Computing";
                "org.opencontainers.image.authors" = "Ad Astra Computing";
                "org.opencontainers.image.licenses" = "BSD-3-Clause";
                "org.opencontainers.image.source" = "https://github.com/Ad-Astra-Computing/vega-agent";
                "org.opencontainers.image.url" = "https://vega-cache.dev";
                "org.opencontainers.image.documentation" = "https://docs.vega-cache.dev";
                "org.opencontainers.image.base.name" = "scratch";
                "dev.vega.runner-version" = githubRunner.version;
                "dev.vega.node-runtimes" = "node24";
              };
            };
          };
        in
        {
          vega-agent = agent;
          default = agent;
        }
        // pkgs.lib.optionalAttrs pkgs.stdenv.isLinux { builder-image = builderImage; }
      );

      apps = forAll (
        system: pkgs:
        let
          p = self.packages.${system}.vega-agent;
          app = bin: {
            type = "app";
            program = "${p}/bin/${bin}";
          };
        in
        {
          vega = app "vega";
          attest = app "vega-attest";
          reproduce = app "vega-reproduce";
          # `nix run github:Ad-Astra-Computing/vega-agent` gives a human the CLI.
          default = app "vega";
        }
      );

      devShells = forAll (
        system: pkgs: {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.zstd
            ];
          };
        }
      );
    };
}
