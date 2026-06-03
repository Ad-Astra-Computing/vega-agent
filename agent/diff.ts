/**
 * The nix and diffoscope shelling behind `vega diff`. Pure arg-building and
 * log-parsing live in `../src/agent/diff.ts`; this module only runs the
 * processes. Every spawn uses an argv array (no shell), and the installable is
 * passed after `--`, so a hostile installable cannot inject a flag or a command.
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildArgs, rebuildArgs, parseRebuild, type RebuildOutcome } from "../src/agent/diff.js";

const execFileP = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

/** Realise the installable (build or substitute) and return its output path. */
export async function ensureBuilt(installable: string): Promise<string> {
  const { stdout } = await execFileP("nix", buildArgs(installable), { maxBuffer: MAX_BUFFER });
  // A multi-output installable prints several paths; take the last (the default
  // output is printed last by nix). Reproducibility of one output is enough to
  // demonstrate a divergence; multi-output drill-down is a later refinement.
  const out = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  if (!out.startsWith("/nix/store/")) {
    throw new Error("could not determine the output path");
  }
  return out;
}

/**
 * Rebuild the installable locally and compare to the realised path. Build logs
 * stream to the user's stderr for live progress and are also captured so the
 * divergence verdict and `.check` path can be parsed from them.
 */
export function rebuildCheck(installable: string): Promise<RebuildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn("nix", rebuildArgs(installable), { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      log += s;
      process.stderr.write(s);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(parseRebuild(log, code ?? 1)));
  });
}

/** Sentinel thrown when diffoscope is not on PATH, so the command can print an
 * install hint instead of a raw spawn error. */
export class DiffoscopeMissing extends Error {}

/**
 * Run diffoscope on the two store paths and return its text report. diffoscope
 * exits 1 when it finds differences (the expected case here), so only a missing
 * binary or an exit code above 1 is a real error.
 */
export async function runDiffoscope(a: string, b: string): Promise<string> {
  try {
    const { stdout } = await execFileP("diffoscope", ["--text", "-", a, b], { maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string };
    if (err.code === 1 && typeof err.stdout === "string") return err.stdout; // differences found
    if (err.code === "ENOENT" || err.code === 127) {
      throw new DiffoscopeMissing("diffoscope not found");
    }
    throw new Error(err.stderr?.trim() || "diffoscope failed");
  }
}
