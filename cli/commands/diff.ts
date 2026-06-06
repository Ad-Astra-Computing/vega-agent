import type { Command } from "commander";
import pc from "picocolors";
import { star, info, success, warn, fail, jsonEvent } from "../ui.js";
import { ensureBuilt, rebuildCheck, runDiffoscope, DiffoscopeMissing } from "../../agent/diff.js";
import { diagnose } from "../../src/diagnosis/report.js";

/**
 * `vega diff <installable>` — a local reproducibility check. It realises the
 * installable, rebuilds it (`nix build --rebuild`), and if the two builds
 * disagree it diffs them with diffoscope and names the likely cause and the
 * standard fix (the same taxonomy Vega uses server-side). Exits non-zero when
 * the build is not reproducible, so it is usable as a CI gate.
 */
export function registerDiff(program: Command): void {
  program
    .command("diff")
    .argument("<installable>", "a flake output, store path, or attr (e.g. .#mypkg)")
    .description("Check a build's reproducibility and explain any divergence")
    .option("--json", "output JSON")
    .action(async (installable: string, opts: { json?: boolean }) => {
      let outPath: string;
      try {
        outPath = await ensureBuilt(installable);
      } catch (e) {
        fail(`could not build ${installable}`, [(e as Error).message]);
      }

      const outcome = await rebuildCheck(installable);

      if (outcome.reproducible) {
        if (opts.json) {
          jsonEvent({ installable, reproducible: true, storePath: outPath });
          return;
        }
        success(`${pc.bold(installable)} is reproducible`);
        info(pc.gray(outPath));
        return;
      }

      if (outcome.checkPath === undefined || outcome.outPath === undefined) {
        // Non-zero exit with no kept `.check`: the rebuild itself failed; that is
        // a build error, not a reproducibility divergence.
        fail("rebuild failed (this is a build error, not a divergence)", [
          "see the build log above",
        ]);
      }

      let diff: string;
      try {
        diff = await runDiffoscope(outcome.outPath!, outcome.checkPath!);
      } catch (e) {
        if (e instanceof DiffoscopeMissing) {
          fail("diffoscope is required to explain a divergence", [
            `nix shell nixpkgs#diffoscope -c vega diff ${installable}`,
            "or install it: nix profile add nixpkgs#diffoscope",
          ]);
        }
        fail("diffoscope failed", [(e as Error).message]);
      }

      const dx = diagnose({ diff: diff!, storePath: outcome.outPath });

      if (opts.json) {
        jsonEvent({
          installable,
          reproducible: false,
          storePath: outcome.outPath,
          checkPath: outcome.checkPath,
          summary: dx.summary,
          findings: dx.findings,
        });
        process.exitCode = 1;
        return;
      }

      warn(`${pc.bold(installable)} is NOT reproducible`);
      info(pc.gray(outcome.outPath!));
      info(pc.gray(outcome.checkPath!));
      process.stderr.write("\n");
      info(star(dx.summary));
      for (const f of dx.findings) {
        process.stderr.write("\n");
        info(`${pc.yellow("cause")}  ${f.title}`);
        info(`${pc.green("fix")}    ${f.fix}`);
        for (const line of f.evidence.slice(0, 3)) {
          info(pc.gray(`  ${line}`));
        }
      }
      if (dx.findings.length === 0) {
        info(pc.gray("No known cause matched the diff."));
        info(pc.gray("See https://docs.vega-cache.dev/reproducibility#divergence"));
      }
      process.exitCode = 1; // a non-reproducible verdict is a failure
    });
}
