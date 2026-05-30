// Build-agent CLI. Runs on a GitHub-hosted runner (Node 20+, nix installed):
//
//   1. exchange the Actions OIDC request token for a JWT scoped to the
//      control plane,
//   2. build the installable,
//   3. for each store path in the closure: dump+compress the NAR, get a
//      presigned URL, upload it to R2, and attest the output.
//
// Orchestration only — the testable protocol/payload logic lives in
// ../src/agent/* (see test/agent-core.test.ts); the nix shelling in ./nix.ts.

import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchActionsOidcToken } from "../src/agent/oidc.js";
import { ControlPlaneClient } from "../src/agent/client.js";
import { buildAttestBody } from "../src/agent/narinfo.js";
import { nixBuild, pathInfoClosure, pathInfoOutputs, makeNar } from "./nix.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const installable = process.argv[2] ?? ".#";
  if (installable.startsWith("-")) {
    throw new Error(`refusing installable that looks like a flag: ${installable}`);
  }
  const controlPlane = requireEnv("VEGA_URL");
  const audience = process.env.VEGA_AUDIENCE || controlPlane;

  const token = await fetchActionsOidcToken(
    {
      requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
      requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    },
    audience,
  );
  // Drop the OIDC minting capability from the environment before we shell out to
  // nix. The exchanged JWT lives only in `token` from here on; nothing nix (or
  // any build) spawns can re-mint a runner-identity token.
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const client = new ControlPlaneClient(controlPlane, token);

  // When the installable names a single attribute (`.#<attr>`), record it as
  // provenance on the top-level output so reproducers know what to rebuild. The
  // bare `.#` (many default outputs) has no single attr, so provenance is left
  // off; the control plane derives the flake ref and revision from the OIDC
  // token regardless.
  const hashIdx = installable.indexOf("#");
  const attr = hashIdx >= 0 ? installable.slice(hashIdx + 1) : "";

  console.log(`Building ${installable} ...`);
  await nixBuild(installable);

  const paths = await pathInfoClosure(installable);
  const topPaths = new Set((await pathInfoOutputs(installable)).map((o) => o.path));
  console.log(`Closure has ${paths.length} path(s).`);

  const work = await mkdtemp(join(tmpdir(), "vega-agent-"));
  let promoted = 0;
  try {
    for (const info of paths) {
      const nar = await makeNar(info.path, work);
      const uploadUrl = await client.uploadUrl(nar.url);
      await client.putNar(uploadUrl, await readFile(nar.file));
      const outputAttr = topPaths.has(info.path) ? attr : "";
      const result = await client.attest(buildAttestBody(info, nar, outputAttr));
      if (result.publishedShared) promoted++;
      const tag = result.publishedShared
        ? "[shared]   "
        : result.publishedTenant
          ? "[tenant]   "
          : "[pending]  ";
      console.log(`${tag} ${info.path} (${result.decision.shared.reason})`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  console.log(`Done. ${promoted}/${paths.length} published to the shared cache.`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
