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
import { ControlPlaneClient } from "../src/agent/client.js";
import { buildAttestBody } from "../src/agent/narinfo.js";
import { partitionByUpstream } from "../src/agent/upstream.js";
import { mapConcurrent } from "../src/agent/concurrency.js";
import { parseVegaConfig, type VegaConfig } from "../src/agent/config.js";
import { resolveBuilds } from "../src/agent/builds.js";
import { nixBuild, pathInfoClosure, pathInfoOutputs, makeNar } from "./nix.js";

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
}

/** Build one installable and upload+attest its (optionally novel-only) closure. */
async function cacheBuild(
  client: ControlPlaneClient,
  installable: string,
  attr: string,
  opts: CacheOpts,
): Promise<{ promoted: number; total: number }> {
  console.log(`Building ${installable} ...`);
  await nixBuild(installable);

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
  const builds = resolveBuilds(config, fallback, flakeDir);
  if (config) console.log(`vega.yaml: building ${builds.length} declared output(s).`);

  const token = await fetchActionsOidcToken(
    {
      requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
      requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    },
    audience,
  );
  // Drop the OIDC minting capability before shelling out to nix: the exchanged
  // JWT lives only in `token`, so nothing a build spawns can re-mint a token.
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const client = new ControlPlaneClient(controlPlane, token);

  const opts: CacheOpts = {
    skipUpstream: process.env.VEGA_SKIP_UPSTREAM === "true",
    upstreamUrl: process.env.VEGA_UPSTREAM || "https://cache.nixos.org",
    work: await mkdtemp(join(tmpdir(), "vega-agent-")),
  };

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
