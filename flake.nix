{
  description = "Vega agent: build, attest, and independently reproduce Nix derivations for the Vega binary cache.";

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
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (
        pkgs:
        let
          agent = pkgs.buildNpmPackage (finalAttrs: {
            pname = "vega-agent";
            version = "0.1.0";
            src = ./.;
            npmDeps = pkgs.importNpmLock { npmRoot = finalAttrs.src; };
            npmConfigHook = pkgs.importNpmLock.npmConfigHook;
            # No build step: tsx runs the TypeScript directly at runtime.
            dontNpmBuild = true;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            # The agent shells out to `nix` and `zstd`, so put them on PATH.
            installPhase = ''
              runHook preInstall
              mkdir -p "$out/lib/vega-agent" "$out/bin"
              cp -r agent cli src package.json node_modules "$out/lib/vega-agent/"
              for pair in attest:main reproduce:reproduce; do
                bin="vega-''${pair%%:*}"
                src="agent/''${pair##*:}.ts"
                makeWrapper ${pkgs.nodejs}/bin/node "$out/bin/$bin" \
                  --add-flags "--import tsx $out/lib/vega-agent/$src" \
                  --chdir "$out/lib/vega-agent" \
                  --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.zstd ]}
              done
              # The user-facing `vega` CLI. zstd is on PATH so `vega push` can
              # compress NARs out of the box; the user's own `nix` is inherited.
              makeWrapper ${pkgs.nodejs}/bin/node "$out/bin/vega" \
                --add-flags "--import tsx $out/lib/vega-agent/cli/main.ts" \
                --chdir "$out/lib/vega-agent" \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.zstd ]}
              runHook postInstall
            '';
          });
        in
        {
          vega-agent = agent;
          default = agent;
        }
      );

      apps = forAll (
        pkgs:
        let
          p = self.packages.${pkgs.system}.vega-agent;
        in
        {
          attest = {
            type = "app";
            program = "${p}/bin/vega-attest";
          };
          reproduce = {
            type = "app";
            program = "${p}/bin/vega-reproduce";
          };
          vega = {
            type = "app";
            program = "${p}/bin/vega";
          };
          default = {
            type = "app";
            program = "${p}/bin/vega-attest";
          };
        }
      );

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs
            pkgs.zstd
          ];
        };
      });
    };
}
