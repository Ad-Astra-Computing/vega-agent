import type { Command } from "commander";
import pc from "picocolors";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { info, success, warn, fail, jsonEvent } from "../ui.js";
import { ensureBuilt } from "../../agent/diff.js";
import { parseClosure, diffClosures, serializeBaseline, parseBaseline } from "../../src/nix/closure.js";
import { assessClosureGate, DEFAULT_GATE_POLICY, type GatePolicy } from "../../src/agent/closure-gate.js";

const execFileP = promisify(execFile);
const MAX_BUFFER = 1 << 28; // 256 MiB for large path-info closures
const DEFAULT_BASELINE = "vega-closure.lock";

interface GateOpts {
  json?: boolean;
  update?: boolean;
  baseline: string;
  warnSizeDeltaPercent: string;
  denySizeDeltaPercent: string;
  warnNewPaths: string;
  denyNewPaths: string;
  allowMissingBaseline?: boolean;
}

/** `nix path-info --json --recursive` over an output's closure (parsed JSON). */
async function closureJson(outPath: string): Promise<unknown> {
  const { stdout } = await execFileP("nix", ["path-info", "--json", "--recursive", "--", outPath], {
    maxBuffer: MAX_BUFFER,
  });
  return JSON.parse(stdout);
}

function num(v: string, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * `vega gate <installable>` — a dependency-closure supply-chain gate. It builds
 * the installable, computes its closure, and compares it against a committed
 * baseline lockfile, reporting what new store paths the change pulled in and
 * emitting an allow/warn/deny verdict (exit non-zero on deny) for CI. `--update`
 * writes the baseline so dependency growth is an explicit, reviewed artifact.
 */
export function registerGate(program: Command): void {
  program
    .command("gate")
    .argument("<installable>", "a flake output, store path, or attr (e.g. .#mypkg)")
    .description("Gate a build on its dependency-closure delta vs a committed baseline")
    .option("--json", "output JSON")
    .option("--update", "write/refresh the baseline lockfile from the current closure")
    .option("--baseline <file>", "baseline lockfile path", DEFAULT_BASELINE)
    .option("--warn-size-delta-percent <n>", "warn above this NAR-size growth", String(DEFAULT_GATE_POLICY.warnSizeDeltaPercent))
    .option("--deny-size-delta-percent <n>", "deny above this NAR-size growth", String(DEFAULT_GATE_POLICY.denySizeDeltaPercent))
    .option("--warn-new-paths <n>", "warn above this many new paths", String(DEFAULT_GATE_POLICY.warnNewPaths))
    .option("--deny-new-paths <n>", "deny above this many new paths", String(DEFAULT_GATE_POLICY.denyNewPaths))
    .option("--allow-missing-baseline", "treat a missing baseline as allow (default: deny)")
    .action(async (installable: string, opts: GateOpts) => {
      let outPath: string;
      try {
        outPath = await ensureBuilt(installable);
      } catch (e) {
        fail(`could not build ${installable}`, [(e as Error).message]);
      }

      let current;
      try {
        current = parseClosure(await closureJson(outPath));
      } catch (e) {
        fail(`could not read the closure of ${installable}`, [(e as Error).message]);
      }

      if (opts.update) {
        try {
          await writeFile(opts.baseline, serializeBaseline(current));
        } catch (e) {
          fail(`could not write baseline ${opts.baseline}`, [(e as Error).message]);
        }
        if (opts.json) return jsonEvent({ installable, updated: opts.baseline, paths: current.length });
        success(`wrote baseline ${pc.bold(opts.baseline)} (${current.length} paths)`);
        return;
      }

      let baselineText: string;
      try {
        baselineText = await readFile(opts.baseline, "utf8");
      } catch {
        const verdict = opts.allowMissingBaseline ? "allow" : "deny";
        if (opts.json) {
          jsonEvent({
            installable,
            verdict,
            reasonCodes: ["closure.missing_baseline"],
            baseline: opts.baseline,
            hint: `vega gate ${installable} --update`,
          });
          if (verdict === "deny") process.exitCode = 1;
          return;
        }
        const next = [`create it: vega gate ${installable} --update`];
        if (opts.allowMissingBaseline) {
          warn(`no baseline ${opts.baseline}`);
          info(next[0]!);
          return;
        }
        fail(`no baseline ${opts.baseline}`, next);
      }

      let baseline;
      try {
        baseline = parseBaseline(baselineText);
      } catch (e) {
        // A corrupt/invalid committed baseline means the gate cannot be trusted: fail closed.
        if (opts.json) {
          jsonEvent({
            installable,
            verdict: "deny",
            reasonCodes: ["closure.invalid_baseline"],
            baseline: opts.baseline,
            error: (e as Error).message,
          });
          process.exitCode = 1;
          return;
        }
        fail(`invalid baseline ${opts.baseline}`, [(e as Error).message, `regenerate it: vega gate ${installable} --update`]);
      }
      const delta = diffClosures(baseline, current);
      const baseTotal = baseline.reduce((n, p) => n + p.narSize, 0);
      const policy: GatePolicy = {
        warnSizeDeltaPercent: num(opts.warnSizeDeltaPercent, DEFAULT_GATE_POLICY.warnSizeDeltaPercent),
        denySizeDeltaPercent: num(opts.denySizeDeltaPercent, DEFAULT_GATE_POLICY.denySizeDeltaPercent),
        warnNewPaths: num(opts.warnNewPaths, DEFAULT_GATE_POLICY.warnNewPaths),
        denyNewPaths: num(opts.denyNewPaths, DEFAULT_GATE_POLICY.denyNewPaths),
        cachePolicy: "off",
      };
      const result = assessClosureGate(delta, baseTotal, policy);

      if (opts.json) {
        jsonEvent({
          installable,
          verdict: result.verdict,
          reasonCodes: result.reasonCodes,
          newPathCount: result.newPathCount,
          removedPathCount: result.removedPathCount,
          sizeDeltaPercent: Number(result.sizeDeltaPercent.toFixed(2)),
          added: delta.added.map((p) => p.path),
          removed: delta.removed.map((p) => p.path),
        });
        if (result.verdict === "deny") process.exitCode = 1;
        return;
      }

      const line = `${result.newPathCount} new, ${result.removedPathCount} removed, +${result.sizeDeltaPercent.toFixed(1)}% added`;
      for (const p of delta.added) info(pc.green(`  + ${p.path}`));
      for (const p of delta.removed) info(pc.gray(`  - ${p.path}`));
      if (result.verdict === "allow") {
        success(`closure gate: allow (${line})`);
      } else if (result.verdict === "warn") {
        warn(`closure gate: warn (${line}) [${result.reasonCodes.join(", ")}]`);
      } else {
        fail(`closure gate: deny (${line}) [${result.reasonCodes.join(", ")}]`, [
          "review the new dependencies above, then update the baseline if intended:",
          `vega gate ${installable} --update`,
        ]);
      }
    });
}
