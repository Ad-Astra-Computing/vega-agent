{
  description = "Vega: the `vega` CLI plus the build agent and reproducer for the Vega binary cache.";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  # The GitHub Actions runner is pinned SEPARATELY from the rest of the toolchain,
  # because GitHub deprecates old runner versions SERVER-SIDE on its own schedule:
  # a deprecated runner is refused before it can self-update, and every deployed
  # builder bricks at once (the store-baked runner cannot update in place). The
  # main pin lagged at github-runner 2.334.0, which GitHub deprecated, taking the
  # whole fleet offline. Advancing only this input re-floats the runner without
  # rebuilding the rest of the image on a fresh nixpkgs. This is the one knob to
  # bump when GitHub deprecates a runner: move it to a rev whose github-runner is
  # current (`nix eval --raw --impure --expr '(import (builtins.getFlake "github:NixOS/nixpkgs/<rev>") {}).github-runner.version'`).
  inputs.nixpkgs-runner.url = "github:NixOS/nixpkgs/8be7bd0c83f12e2e3bbba07c9044d6fed9e66f7f";

  outputs =
    { self, nixpkgs, nixpkgs-runner }:
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
            version = "0.17.1";
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
                  --add-flags "--import file://$out/lib/vega-agent/node_modules/tsx/dist/loader.mjs" \
                  --add-flags "$out/lib/vega-agent/$script" \
                  --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.zstd ]}
              done

              # The user-facing `vega` CLI.
              # The loader is named by absolute path and the wrapper does NOT change
              # directory. `--import tsx` resolves against the working directory,
              # which is why this used to chdir into the store, and that broke every
              # command that means "here": `vega push` with no argument built the
              # store's own lib directory, `vega init` wrote into a read-only path,
              # and `gate` and `diff` resolved relative installables against it.
              makeWrapper ${nodejs}/bin/node "$out/bin/vega" \
                --add-flags "--import file://$out/lib/vega-agent/node_modules/tsx/dist/loader.mjs" \
                --add-flags "$out/lib/vega-agent/cli/main.ts" \
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
          # Taken from nixpkgs-runner (a separately advanceable pin), NOT the main
          # nixpkgs, so a server-side runner deprecation is a one-input bump.
          githubRunner = nixpkgs-runner.legacyPackages.${system}.github-runner.override { nodeRuntimes = [ "node24" ]; };
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
          # The closure registration for everything baked into the image. The
          # entrypoint loads this into the Nix DB at startup so the store paths
          # are VALID with their references recorded. Without it a real (sandbox =
          # true) build cannot mount each input's closure and the builder fails to
          # find its interpreter (glibc), e.g. `bash: No such file or directory`.
          builderReginfo = pkgs.closureInfo { rootPaths = [ builderRoot ]; };
          builderImage = pkgs.dockerTools.buildLayeredImage {
            name = "vega-builder";
            # No `created` (defaults to epoch) so the digest stays reproducible.
            tag = agent.version;
            contents = [ builderRoot ];
            # /tmp, the runner's writable home, the baked closure registration,
            # the boot shim and the store seed. The shim and its busybox
            # interpreter are REAL FILES under /bin, not symlinks into
            # /nix/store: a persistent /nix volume from an older image masks
            # the image's store (Docker seeds a volume only when it is empty),
            # which used to leave the entrypoint symlink dangling and kill the
            # container at exec on every image update. The shim detects that
            # and seeds /nix-seed/store (a duplicate of the baked closure,
            # living outside /nix precisely so the volume cannot mask it) into
            # the volume, making image updates self-healing. The seed roughly
            # doubles the image; the fast path (no volume, or an already
            # seeded one) never touches it.
            extraCommands = ''
              mkdir -p tmp home/runner etc/vega bin nix-seed/store
              chmod 1777 tmp
              cp ${builderReginfo}/registration etc/vega/nix-registration
              cp ${pkgs.pkgsStatic.busybox}/bin/busybox bin/busybox
              cp ${./builder/bootstrap.sh} bin/vega-bootstrap
              chmod 755 bin/busybox bin/vega-bootstrap
              while read -r p; do
                cp -a "$p" nix-seed/store/
              done < ${builderReginfo}/store-paths
            '';
            config = {
              Entrypoint = [ "/bin/vega-bootstrap" ];
              Env = [
                "PATH=/bin"
                "HOME=/home/runner"
                "USER=runner"
                "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                "NIX_SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                "RUNNER_DIST=${githubRunner}"
                "VEGA_BUILDER_VERSION=${agent.version}"
                "VEGA_NIX_REGINFO=/etc/vega/nix-registration"
                # The buildEnv holding the whole baked closure. The entrypoint
                # registers a Nix GC root for it on every boot so the in-container
                # periodic GC cannot delete the paths the container needs to boot.
                "VEGA_BUILDER_ROOT=${builderRoot}"
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
