// Node-side adapter shelling out to the `nix` CLI. This is the integration
// boundary the workerd test suite cannot exercise (no nix, no child_process in
// the isolate). It is written to be correct and minimal, but the exact `nix`
// output shapes/flags vary by version — VERIFY ON A REAL RUNNER before relying
// on it. The pure logic it feeds (payload construction, the HTTP client) is
// covered by test/agent-core.test.ts.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { RawPathInfo, NarArtifact } from "../src/agent/narinfo.js";
import { storePathHash } from "../src/nix/store-path.js";

const exec = promisify(execFile);
const MAX_BUFFER = 1 << 28; // 256 MiB for large path-info closures

/** Normalize any nix hash string to narinfo form `sha256:<nixbase32>`. */
async function toNarinfoHash(hash: string): Promise<string> {
  if (hash.startsWith("sha256:")) return hash; // already nixbase32-form
  // SRI (`sha256-<base64>`) or other — let nix convert it.
  const { stdout } = await exec("nix", [
    "hash",
    "convert",
    "--hash-algo",
    "sha256",
    "--to",
    "nix32",
    "--",
    hash,
  ]);
  const out = stdout.trim();
  return out.startsWith("sha256:") ? out : `sha256:${out}`;
}

/** The runner's Nix system double, e.g. `x86_64-linux`, used to expand declared
 * devShell names to `devShells.<system>.<name>`. */
export async function currentSystem(): Promise<string> {
  const { stdout } = await exec("nix", ["eval", "--impure", "--raw", "--expr", "builtins.currentSystem"]);
  return stdout.trim();
}

/** `nix flake show --json` for the flake at `flakeDir` (current system only), so
 * vega.yaml `include`/`exclude` matchers can be expanded against real outputs. */
export async function flakeShow(flakeDir: string): Promise<unknown> {
  const { stdout } = await exec("nix", ["flake", "show", "--json", "--", flakeDir], { maxBuffer: MAX_BUFFER });
  return JSON.parse(stdout);
}

/** Default build timeout (ms); a hung build fails the job instead of idling. */
const BUILD_TIMEOUT_MS = Number(process.env.VEGA_BUILD_TIMEOUT_MS) || 60 * 60 * 1000;

/**
 * Build an installable, STREAMING nix's build logs to stderr so CI shows live
 * progress (a buffered exec would make a long build look hung). Throws on a
 * non-zero exit or if the build exceeds the timeout.
 */
export function nixBuild(
  installable: string,
  opts: { substituters?: string[]; trustedKeys?: string[] } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    // `--` terminates option parsing (installable is attacker-controlled, so a
    // value like `--store ...` must not be read as a flag). `-L` prints build
    // logs so progress is visible; inherit stderr so they reach the CI console.
    const args = ["build", "--no-link", "-L"];
    // Register extra substituters/keys (e.g. Vega's own tenant cache) so a cold
    // runner pulls previously-pushed paths instead of rebuilding them.
    if (opts.substituters?.length) args.push("--extra-substituters", opts.substituters.join(" "));
    if (opts.trustedKeys?.length) {
      args.push("--extra-trusted-public-keys", opts.trustedKeys.join(" "));
    }
    args.push("--", installable);
    const child = spawn("nix", args, {
      stdio: ["ignore", "ignore", "inherit"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`nix build timed out after ${Math.round(BUILD_TIMEOUT_MS / 60000)}m`));
    }, BUILD_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`nix build exited with code ${code}`));
    });
  });
}

/** `nix path-info --json --recursive` over the closure of an installable. */
export async function pathInfoClosure(installable: string): Promise<RawPathInfo[]> {
  return pathInfo(installable, true);
}

/** `nix path-info --json` for an installable's top-level output(s) only. */
export async function pathInfoOutputs(installable: string): Promise<RawPathInfo[]> {
  return pathInfo(installable, false);
}

async function pathInfo(installable: string, recursive: boolean): Promise<RawPathInfo[]> {
  const args = ["path-info", "--json"];
  if (recursive) args.push("--recursive");
  args.push("--", installable); // `--`: installable is attacker-controlled (see nixBuild)
  const { stdout } = await exec("nix", args, { maxBuffer: MAX_BUFFER });
  const parsed = JSON.parse(stdout) as
    | RawNixPathInfo[]
    | Record<string, Omit<RawNixPathInfo, "path">>;

  const raw: RawNixPathInfo[] = Array.isArray(parsed)
    ? parsed
    : Object.entries(parsed).map(([path, v]) => ({ path, ...v }));

  return Promise.all(
    raw.map(async (e) => ({
      path: e.path,
      narHash: await toNarinfoHash(e.narHash),
      narSize: e.narSize,
      references: e.references ?? [],
      deriver: e.deriver ?? null,
    })),
  );
}

interface RawNixPathInfo {
  path: string;
  narHash: string;
  narSize: number;
  references?: string[];
  deriver?: string | null;
}

/**
 * Dump a store path to a zstd-compressed NAR on disk and return its artifact
 * facts. The file is named by the store-path hash (unique per output).
 */
export async function makeNar(
  path: string,
  outDir: string,
): Promise<NarArtifact & { file: string }> {
  const file = join(outDir, `${storePathHash(path)}.nar.zst`);
  await dumpCompressed(path, file);
  const { size } = await stat(file);
  // nixHashFile returns the bare nixbase32 digest; narinfo wants `sha256:<...>`.
  const fileHash = `sha256:${await nixHashFile(file)}`;
  // Content-address the NAR by its compressed hash so divergent builds of the
  // same store path never collide on one R2 key (and identical builds dedupe).
  const b32 = fileHash.slice("sha256:".length);
  return {
    url: `nar/${b32}.nar.zst`,
    compression: "zstd",
    fileHash,
    fileSize: size,
    file,
  };
}

/** `nix store dump-path <path> | zstd` into `file`. */
function dumpCompressed(path: string, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const dump = spawn("nix", ["store", "dump-path", "--", path]);
    // Level 8, not 19: R2 egress is free and storage is cheap, so trading a little
    // ratio for much faster compression is the right call. Single-threaded so the
    // per-path pipeline can run several paths in parallel without core contention.
    const zstd = spawn("zstd", ["-8", "-c"]);
    const out = createWriteStream(file);
    dump.stdout.pipe(zstd.stdin);
    zstd.stdout.pipe(out);
    const fail = (e: unknown) => reject(e instanceof Error ? e : new Error(String(e)));
    dump.on("error", fail);
    zstd.on("error", fail);
    out.on("error", fail);
    out.on("finish", resolve);
  });
}

/** Hash a file with sha256, returning the bare nixbase32 digest. */
async function nixHashFile(file: string): Promise<string> {
  // `nix hash file` takes `--type`/`--base32` (NOT the `--hash-algo`/`--to` of
  // `nix hash convert`); `--base32` emits the bare nixbase32 digest.
  const { stdout } = await exec("nix", [
    "hash",
    "file",
    "--type",
    "sha256",
    "--base32",
    "--",
    file,
  ]);
  return stdout.trim();
}
