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
            version = "0.2.0";
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
        in
        {
          vega-agent = agent;
          default = agent;
        }
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
