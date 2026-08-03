// Reproducer CLI (the layer-5 external builder). Given a build's provenance
// (flake ref, attribute, locked revision), it rebuilds the SAME derivation on a
// fresh runner under its own identity and attests the result. Agreement on the
// fingerprint with the original attester is what promotes the output to the
// shared tier; disagreement on narHash surfaces as a divergence.
//
// Runs on a GitHub-hosted runner (Linux or macOS) in a repo distinct from the
// original attester, so its OIDC identity is a distinct tenant. Inputs arrive as
// env vars set by the reusable workflow.
//
// Orchestration only; the testable installable/payload logic lives in
// ../src/agent/reproduce.ts and ../src/agent/narinfo.ts.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchActionsOidcToken } from "../src/agent/oidc.js";
import { OidcTokenProvider } from "../src/agent/token-provider.js";
import { ControlPlaneClient } from "../src/agent/client.js";
import { buildAttestBody } from "../src/agent/narinfo.js";
import { lockedInstallable } from "../src/agent/reproduce.js";
import { sanitizeFlakeDir, sanitizeFlakeAttr } from "../src/nix/flake-dir.js";
import type { BuildProvenance } from "../src/trust/policy.js";
import { sha256NixHashToBase64 } from "../src/nix/hash.js";
import { nixBuild, pathInfoOutputs, makeNar, assertSubflakeDirContained } from "./nix.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const controlPlane = requireEnv("VEGA_URL");
  const audience = process.env.VEGA_AUDIENCE || controlPlane;
  // Sanitize the flake attribute before it steers what this trusted reproducer
  // builds (`...#<attr>`). Like the subflake dir, VEGA_ATTR is attester-supplied
  // via the dispatch inputs, so a value that is not a plain flake attribute path
  // is rejected, not built. Defense in depth: the attr sits after the `#` and
  // every nix call uses `--`, but the guard must actually run on the input.
  const rawAttr = requireEnv("VEGA_ATTR");
  const attr = sanitizeFlakeAttr(rawAttr);
  if (attr === null) throw new Error(`refusing unsafe flake attr: ${JSON.stringify(rawAttr)}`);
  const provenance: BuildProvenance = {
    flakeRef: requireEnv("VEGA_FLAKE_REF"),
    attr,
    rev: requireEnv("VEGA_REV"),
  };
  // Optional subflake directory. Re-sanitize here as defense in depth (the edge
  // sanitizes on ingest): this value steers what this trusted reproducer builds,
  // so an unexpected value (e.g. a tampered dispatch input) must be rejected, not
  // built. An empty/absent env is a root flake.
  const rawDir = process.env.VEGA_DIR || "";
  if (rawDir !== "") {
    const dir = sanitizeFlakeDir(rawDir);
    if (dir === null) throw new Error(`refusing unsafe subflake dir: ${JSON.stringify(rawDir)}`);
    provenance.dir = dir;
  }
  // Optional: the output the original attester claims, for a local divergence
  // report (the authoritative comparison is server-side). Empty env = unset.
  const expectPath = process.env.VEGA_EXPECT_STORE_PATH || undefined;
  const expectNarHash = process.env.VEGA_EXPECT_NARHASH || undefined;

  // Mint the OIDC identity token and drop the minting capability from the
  // environment BEFORE any nix invocation on attacker-chosen input. This build
  // is UNTRUSTED (an attacker chose the flake ref) and the subflake containment
  // check below runs `nix eval` on that repo, so the runner-identity minting
  // endpoint must already be gone from the environment by then. Nothing the
  // build or eval spawns can re-mint a token; the request credential lives only
  // in this closure and the exchanged JWT never re-enters the environment, and
  // flakes evaluate in pure mode so `builtins.getEnv` cannot read it either.
  // (Building untrusted code still warrants an ephemeral runner; see
  // docs/external-builder.md.)
  //
  // Capture the request credential into a closure, then drop it from the
  // environment; the provider re-mints a fresh JWT on demand. A reproduction is
  // precisely the long-build lane, so a single up-front token would expire
  // during `nix build` and 401 at upload/attest after the whole rebuild. This
  // mirrors agent/main.ts.
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

  // Before building a subflake, verify the dir is a real, contained subdirectory
  // at this exact rev with no symlinked component, so a committed symlink cannot
  // steer this trusted reproducer outside the pinned source tree.
  if (provenance.dir !== undefined) {
    await assertSubflakeDirContained(provenance.flakeRef, provenance.rev, provenance.dir);
  }

  const installable = lockedInstallable(provenance);
  const client = new ControlPlaneClient(controlPlane, (force) => provider.get(force));

  console.log(`Reproducing ${installable} ...`);
  await nixBuild(installable);
  const outputs = await pathInfoOutputs(installable);

  const work = await mkdtemp(join(tmpdir(), "vega-reproduce-"));
  let agreed = 0;
  let diverged = 0;
  try {
    for (const info of outputs) {
      if (expectPath !== undefined && info.path !== expectPath) {
        console.log(`[mismatch] built ${info.path}, expected ${expectPath}`);
      }
      if (expectNarHash !== undefined) {
        const verdict = info.narHash === expectNarHash ? "reproduced" : "DIVERGED";
        console.log(`[${verdict}] ${info.path}`);
        if (info.narHash !== expectNarHash) diverged++;
      }
      const nar = await makeNar(info.path, work);
      // uploadNar streams the NAR from disk (file-backed Blob, not buffered: large
      // closures otherwise OOM the worker) and re-mints on a presign expiry.
      const checksum = sha256NixHashToBase64(nar.fileHash);
      await client.uploadNar(nar.url, nar.fileHash, nar.file, checksum);
      const result = await client.attest(buildAttestBody(info, nar, provenance.attr));
      if (result.publishedShared) agreed++;
      // The parenthetical is the shared-tier decision reason, not an upload
      // status (same convention as the attester's per-path lines).
      const tag = result.publishedShared ? "[shared]" : "[pending]";
      const reason = result.decision.shared.reason;
      console.log(`${tag} ${info.path} (${result.publishedShared ? reason : `shared tier: ${reason}`})`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  console.log(`Done. ${agreed} promoted, ${diverged} diverged, of ${outputs.length} output(s).`);
  // A reproduction that diverged is a real signal; fail the job so it is visible.
  if (diverged > 0) process.exit(2);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
