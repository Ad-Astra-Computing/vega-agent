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

/** Build an installable, returning nothing (throws on failure). */
export async function nixBuild(installable: string): Promise<void> {
  // `--` terminates option parsing: the installable is attacker-controlled, so
  // a value like `--store ...` must not be read by nix as a flag.
  await exec("nix", ["build", "--no-link", "--", installable], { maxBuffer: MAX_BUFFER });
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
    const zstd = spawn("zstd", ["-19", "-c"]);
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
