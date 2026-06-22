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
import { stat, lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { RawPathInfo, NarArtifact } from "../src/agent/narinfo.js";
import { storePathHash } from "../src/nix/store-path.js";

const exec = promisify(execFile);

/**
 * Verify that the subflake `dir` is a real, CONTAINED subdirectory of the repo at
 * `flakeRef`@`rev` with no symlinked path component, before this trusted
 * reproducer builds `<flakeRef>/<rev>?dir=<dir>#<attr>`.
 *
 * The string sanitizer (sanitizeFlakeDir) blocks lexical traversal (`..`, etc.),
 * but a repository can COMMIT a symlink at a `dir` component pointing outside the
 * tree; if nix followed it, the reproducer would build from outside the pinned
 * source. We fetch the source tree (evaluation-free, so it works even when the
 * repo root has no flake.nix) and `lstat` each component, rejecting any symlink or
 * non-directory, plus a realpath-containment backstop. Throws to abort the build.
 *
 * VERIFY ON A REAL RUNNER: depends on `nix eval` / `builtins.fetchTree` behavior.
 */
export async function assertSubflakeDirContained(
  flakeRef: string,
  rev: string,
  dir: string,
): Promise<void> {
  // Require the EXACT canonical bare form and an immutable 40-hex commit SHA, so
  // the tree fetched here is precisely the one `lockedInstallable` builds (a
  // mutable ref or a non-canonical form could resolve to a different tree -> a
  // check/build TOCTOU). Ingest enforces the same, this is defense in depth.
  const m = /^github:([^/?#]+)\/([^/?#]+)$/.exec(flakeRef);
  if (m === null) {
    throw new Error(`refusing a subflake dir on a non-canonical github flake ref: ${flakeRef}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(rev)) {
    throw new Error(`refusing a subflake dir without an immutable commit SHA rev: ${rev}`);
  }
  const owner = m[1]!;
  const repo = m[2]!;
  // fetchTree of a github source pinned to `rev` is locked (pure); --raw prints the
  // bare store path. JSON.stringify safely quotes the (already-sanitized) parts.
  const expr = `(builtins.fetchTree { type = "github"; owner = ${JSON.stringify(owner)}; repo = ${JSON.stringify(repo)}; rev = ${JSON.stringify(rev)}; }).outPath`;
  const { stdout } = await exec("nix", ["eval", "--raw", "--expr", expr]);
  const src = stdout.trim();
  if (!src.startsWith("/nix/store/")) {
    throw new Error(`unexpected source path fetching ${owner}/${repo}@${rev}: ${src}`);
  }
  // Walk each component: it must exist, be a directory, and NOT be a symlink.
  // lstat does not follow the final component, so a symlinked component is caught.
  let cur = src;
  for (const seg of dir.split("/")) {
    cur = join(cur, seg);
    const st = await lstat(cur);
    if (st.isSymbolicLink()) {
      throw new Error(`subflake dir component is a symlink (refusing to escape the repo): ${dir}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`subflake dir component is not a directory: ${dir}`);
    }
  }
  // Backstop: the resolved subflake path must remain within the source tree.
  const realSrc = await realpath(src);
  const realDir = await realpath(join(src, dir));
  if (realDir !== realSrc && !realDir.startsWith(realSrc + "/")) {
    throw new Error(`subflake dir escapes the repository tree: ${dir}`);
  }
}
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

/**
 * Optional per-build timeout (ms). DISABLED by default (0): the CI job's own
 * `timeout-minutes` is the source of truth for "too long", so the agent never
 * SIGTERM-kills a build before the job would (which discarded all built paths
 * and made Vega look broken on heavy closures). Opt in via the action input
 * `build-timeout-minutes` (-> VEGA_BUILD_TIMEOUT_MINUTES) or the low-level
 * `VEGA_BUILD_TIMEOUT_MS`; minutes wins if both are set.
 */
const BUILD_TIMEOUT_MS =
  (Number(process.env.VEGA_BUILD_TIMEOUT_MINUTES) || 0) * 60_000 ||
  Number(process.env.VEGA_BUILD_TIMEOUT_MS) ||
  0;

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
    // Only arm a timer when a timeout is explicitly configured; otherwise the CI
    // job timeout governs and a long-but-progressing build is never killed.
    const timer =
      BUILD_TIMEOUT_MS > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error(`nix build timed out after ${Math.round(BUILD_TIMEOUT_MS / 60000)}m`));
          }, BUILD_TIMEOUT_MS)
        : undefined;
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
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
