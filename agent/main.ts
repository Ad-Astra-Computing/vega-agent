// Build-agent CLI. Runs on a GitHub-hosted runner (Node 20+, nix installed):
//
//   1. exchange the Actions OIDC request token for a JWT scoped to the
//      control plane,
//   2. resolve what to build (a vega.yaml in the repo, or the CLI installable),
//   3. for each build: build it, then for each store path in the closure (minus
//      upstream-cached paths when caching) dump+compress the NAR, get a
//      presigned URL, upload it, and attest the output.
//
// Orchestration only. The testable logic lives in ../src/agent/* (config,
// builds, upstream; see test/), and the nix shelling in ./nix.ts.

import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { fetchActionsOidcToken } from "../src/agent/oidc.js";
import { OidcTokenProvider } from "../src/agent/token-provider.js";
import { ControlPlaneClient } from "../src/agent/client.js";
import { buildAttestBody } from "../src/agent/narinfo.js";
import { partitionByUpstream } from "../src/agent/upstream.js";
import { mapConcurrent } from "../src/agent/concurrency.js";
import { tenantSubstituter } from "../src/agent/substituter.js";
import { parseVegaConfig, type VegaConfig } from "../src/agent/config.js";
import { resolveBuilds } from "../src/agent/builds.js";
import { nixBuild, pathInfoClosure, pathInfoOutputs, makeNar, currentSystem, flakeShow } from "./nix.js";
import { flattenFlakeShow } from "../src/agent/outputs.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

/** Load and validate `vega.yaml` from the repo root, or null if there is none. */
async function readVegaConfig(flakeDir: string): Promise<VegaConfig | null> {
  let raw: string;
  try {
    raw = await readFile(join(flakeDir, "vega.yaml"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  // A present-but-invalid vega.yaml is a hard error, not a silent fallback.
  return parseVegaConfig(parseYaml(raw));
}

interface CacheOpts {
  skipUpstream: boolean;
  upstreamUrl: string;
  work: string;
  /** Extra substituters (Vega's own tenant cache) so cold builds reuse prior pushes. */
  substituters?: string[];
  trustedKeys?: string[];
}

/** Build one installable and upload+attest its (optionally novel-only) closure. */
async function cacheBuild(
  client: ControlPlaneClient,
  installable: string,
  attr: string,
  opts: CacheOpts,
): Promise<{ promoted: number; total: number }> {
  console.log(`Building ${installable} ...`);
  await nixBuild(installable, { substituters: opts.substituters, trustedKeys: opts.trustedKeys });

  const closure = await pathInfoClosure(installable);
  const topPaths = new Set((await pathInfoOutputs(installable)).map((o) => o.path));
  console.log(`Closure has ${closure.length} path(s).`);

  let paths = closure;
  if (opts.skipUpstream) {
    const { novel, upstream } = await partitionByUpstream(
      closure.map((p) => p.path),
      opts.upstreamUrl,
    );
    const novelSet = new Set(novel);
    paths = closure.filter((p) => novelSet.has(p.path));
    console.log(`Skipping ${upstream.length} path(s) in ${opts.upstreamUrl}; pushing ${paths.length} novel.`);
  }

  // Compress + upload + attest each path with bounded concurrency, so a large
  // closure's paths overlap instead of running strictly one at a time. Modest
  // by default since each task reads its NAR into memory before the PUT.
  const concurrency = Number(process.env.VEGA_UPLOAD_CONCURRENCY) || 4;
  const shared = await mapConcurrent(paths, concurrency, async (info) => {
    const nar = await makeNar(info.path, opts.work);
    const uploadUrl = await client.uploadUrl(nar.url);
    await client.putNar(uploadUrl, await readFile(nar.file));
    const outputAttr = topPaths.has(info.path) ? attr : "";
    const result = await client.attest(buildAttestBody(info, nar, outputAttr));
    const tag = result.publishedShared
      ? "[shared]   "
      : result.publishedTenant
        ? "[tenant]   "
        : "[pending]  ";
    console.log(`${tag} ${info.path} (${result.decision.shared.reason})`);
    return result.publishedShared;
  });
  return { promoted: shared.filter(Boolean).length, total: paths.length };
}

async function main(): Promise<void> {
  const fallback = process.argv[2] ?? ".#";
  if (fallback.startsWith("-")) {
    throw new Error(`refusing installable that looks like a flag: ${fallback}`);
  }
  const controlPlane = requireEnv("VEGA_URL");
  const audience = process.env.VEGA_AUDIENCE || controlPlane;

  // vega.yaml lives in the checked-out repo; GITHUB_WORKSPACE is its root.
  const flakeDir = process.env.GITHUB_WORKSPACE || process.cwd();
  const config = await readVegaConfig(flakeDir);
  // devShells need the runner's system; include/exclude need the flake's outputs.
  const sys = config && config.devShells.length > 0 ? await currentSystem() : undefined;
  const flakeOutputs =
    config && config.include.length > 0 ? flattenFlakeShow(await flakeShow(flakeDir)) : undefined;
  const builds = resolveBuilds(config, fallback, flakeDir, sys, flakeOutputs);
  if (config) console.log(`vega.yaml: building ${builds.length} declared output(s).`);

  // Capture the runner's OIDC request credential, then DROP it from the
  // environment before shelling out to nix, so nothing a build spawns can mint a
  // token. The credential lives only in this closure; the provider re-mints a
  // fresh JWT on demand, so a long build never leaves an expired token at push.
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const provider = new OidcTokenProvider(() =>
    fetchActionsOidcToken({ requestUrl, requestToken }, audience),
  );
  // Mint once up front to fail fast if `id-token: write` is missing, rather than
  // only after a long build. The provider re-mints when the token nears expiry.
  await provider.get();
  const client = new ControlPlaneClient(controlPlane, () => provider.get());

  const opts: CacheOpts = {
    skipUpstream: process.env.VEGA_SKIP_UPSTREAM === "true",
    upstreamUrl: process.env.VEGA_UPSTREAM || "https://cache.nixos.org",
    work: await mkdtemp(join(tmpdir(), "vega-agent-")),
  };

  // Register Vega's own tenant cache as a substituter so a cold runner pulls
  // paths this repo previously pushed (e.g. the uncached nvim-treesitter query
  // derivations) from Vega instead of rebuilding them. Best-effort: if the key
  // can't be fetched, build without it.
  //
  // OPT-IN only: a build that substitutes from Vega is no longer independent of
  // Vega, so this must stay OFF for the reproducer lane and any job whose build
  // feeds shared-tier attestation evidence. Otherwise a compromised Vega could
  // feed a malicious substitute into a build that then vouches for it.
  // Enabled by the action input (VEGA_REUSE_CACHE) or `reuse-cache: true` in vega.yaml.
  const repository = process.env.GITHUB_REPOSITORY;
  const reuseCache = process.env.VEGA_REUSE_CACHE === "true" || (config?.reuseCache ?? false);
  if (repository && reuseCache) {
    try {
      const { url, keyUrl } = tenantSubstituter(controlPlane, repository);
      const res = await fetch(keyUrl);
      if (res.ok) {
        const { publicKey } = (await res.json()) as { publicKey?: string };
        if (typeof publicKey === "string" && publicKey !== "") {
          opts.substituters = [url];
          opts.trustedKeys = [publicKey];
          console.log(`Reusing prior pushes from ${url}`);
        }
      }
    } catch {
      /* best-effort: proceed without the Vega substituter */
    }
  }

  let promoted = 0;
  let total = 0;
  try {
    for (const b of builds) {
      const r = await cacheBuild(client, b.installable, b.attr, opts);
      promoted += r.promoted;
      total += r.total;
    }
  } finally {
    await rm(opts.work, { recursive: true, force: true });
  }

  console.log(`Done. ${promoted}/${total} published to the shared cache.`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
