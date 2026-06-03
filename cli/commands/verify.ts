import type { Command } from "commander";
import pc from "picocolors";
import { DEFAULT_CONTROL_PLANE, assertSafeControlPlane, controlPlaneFor } from "../context.js";
import { star, info, success, warn, fail, keyValues, jsonEvent } from "../ui.js";
import { parsePublicKey } from "../../src/nix/signing.js";
import { parseNarInfo } from "../../src/nix/narinfo.js";
import { checkNarHash } from "../nar-check.js";
import type { NixPublicKey } from "../../src/nix/types.js";
import { trustedKeys, pickTrustedKey } from "../keys.js";
import { verifyBuild, fullyVerified, type Fetcher, type VerifyResult } from "../verify-core.js";

const SHARED_KEY_NAME = "vega-cache-1";

/** Extract the 32-char store-path hash from a path, basename, hash, or .narinfo. */
function extractHash(arg: string): string {
  const noSuffix = arg.replace(/\.narinfo$/, "");
  const base = noSuffix.includes("/") ? noSuffix.slice(noSuffix.lastIndexOf("/") + 1) : noSuffix;
  const hash = base.split("-")[0]!;
  if (!/^[0-9a-z]{32}$/.test(hash)) {
    fail(`'${arg}' is not a store path or hash`, [
      "vega verify /nix/store/<hash>-name",
      "vega verify <hash>",
    ]);
  }
  return hash;
}

/** True only for an exact tenant substituter path: `/tenant/<owner>/<repo>` (the
 * gh-actions tenant) or `/tenant/owner:<id>` (the owner-push namespace). Used to
 * gate tenant-only behavior; a loose match like `/foo/tenant/bar` must not pass. */
export function isTenantScope(cacheUrl: string): boolean {
  try {
    const p = new URL(cacheUrl).pathname.replace(/\/+$/, "");
    return /^\/tenant\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(p) || /^\/tenant\/owner:[0-9]+$/.test(p);
  } catch {
    return false;
  }
}

/** Resolve the key to verify against, in order: explicit flag, then a
 * trusted-public-keys entry whose name matches the narinfo's signature, then —
 * for a tenant-scoped cache — the verification key the cache publishes at
 * `<url>/key`. */
async function resolveKey(cacheUrl: string, sigNames: string[], flag?: string): Promise<NixPublicKey> {
  if (flag) {
    try {
      return parsePublicKey(flag);
    } catch {
      fail(`--public-key is not a valid '<name>:<base64>' key`);
    }
  }
  const pk = pickTrustedKey(await trustedKeys(), sigNames);
  if (pk) return pk;
  // A tenant-scoped cache (URL under /tenant/<owner>/<repo>) publishes its own
  // verification key at <url>/key, so verifying your OWN tenant build needs no
  // prior key setup. The shared scope is deliberately excluded: its signature
  // must be checked against the pinned shared key, never one served by the same
  // cache it certifies. Transparency-log inclusion and the NAR re-hash are
  // verified independently of this key.
  if (isTenantScope(cacheUrl)) {
    try {
      const res = await fetch(`${cacheUrl}/key`);
      if (res.ok) {
        const { publicKey } = (await res.json()) as { publicKey?: unknown };
        if (typeof publicKey === "string") {
          const name = publicKey.slice(0, publicKey.indexOf(":")).trim();
          if (sigNames.includes(name)) {
            warn(
              `using the tenant key '${name}' published by the cache; pin it with --public-key for third-party verification.`,
            );
            return parsePublicKey(publicKey);
          }
        }
      }
    } catch {
      // Fall through to the explicit-key guidance below.
    }
  }
  fail(
    `no trusted public key found for this build (it is signed by: ${sigNames.join(", ") || "nothing"}).`,
    [
      `add the key to trusted-public-keys in nix.conf, or pass it explicitly:`,
      `  vega verify <hash> --public-key '${SHARED_KEY_NAME}:<base64>'`,
      `the shared key is published at ${DEFAULT_CONTROL_PLANE}`,
    ],
  );
}


function tick(ok: boolean): string {
  return ok ? pc.green("ok") : pc.red("FAIL");
}

export function registerVerify(program: Command): void {
  program
    .command("verify")
    .argument("<store-path-or-hash>", "a /nix/store path, store-path hash, or <hash>.narinfo")
    .description("Independently verify a build: signature, transparency log, and NAR bytes")
    .option("--url <url>", "cache URL", DEFAULT_CONTROL_PLANE)
    .option("--public-key <key>", "trusted key to verify against (<name>:<base64>)")
    .option("--no-nar", "skip downloading and re-deriving the NAR hash")
    .option("--max-scan <n>", "max transparency-log entries to scan", (v) => Number(v))
    .option(
      "--allow-signature-only",
      "exit 0 for a valid scoped or upstream-mirror signature (default: only full shared verification exits 0)",
    )
    .option("--json", "output JSON")
    .action(
      async (
        target: string,
        opts: {
          url: string;
          publicKey?: string;
          nar: boolean;
          maxScan?: number;
          allowSignatureOnly?: boolean;
          json?: boolean;
        },
      ) => {
        const cacheUrl = assertSafeControlPlane(controlPlaneFor(opts.url));
        const hash = extractHash(target);

        // Fetch the narinfo ONCE; this single snapshot drives key resolution,
        // signature + log verification, and the NAR re-derivation, so a cache
        // cannot serve one narinfo to be verified and another to be hashed.
        const res = await fetch(`${cacheUrl}/${hash}.narinfo`);
        if (!res.ok) fail(`no build found for ${hash} (HTTP ${res.status})`);
        const narInfo = parseNarInfo(await res.text());
        const sigNames = narInfo.sigs.map((s) => s.slice(0, s.indexOf(":")).trim()).filter(Boolean);
        const publicKey = await resolveKey(cacheUrl, sigNames, opts.publicKey);

        const fetcher: Fetcher = (path) => fetch(`${cacheUrl}${path}`);
        const result: VerifyResult = await verifyBuild({
          fetcher,
          info: narInfo,
          publicKey,
          sharedKeyName: SHARED_KEY_NAME,
          maxScan: opts.maxScan,
        });

        const nar = opts.nar
          ? await checkNarHash((p) => fetch(`${cacheUrl}${p}`, { signal: AbortSignal.timeout(60_000) }), narInfo)
          : null;

        const sig = result.signature;
        const t = result.transparency;
        const narOk = nar === null || nar.ok;
        const verified = fullyVerified(result) && narOk;
        // Pointing verify at a tenant scope (--url .../tenant/<owner>/<repo>) is
        // an explicit request to verify a tenant build, for which a valid Vega
        // tenant-key signature ("scoped") plus actually-checked matching bytes IS
        // the success criterion. Requires the NAR check (not --no-nar) and the
        // scoped Vega key specifically, never an upstream-mirror signature.
        const narChecked = nar !== null && nar.ok;
        const tenantOk = isTenantScope(cacheUrl) && sig.ok && sig.scope === "scoped" && narChecked;
        // A valid scoped/upstream signature is a real result but NOT full Vega
        // verification; outside a tenant scope it only yields exit 0 when
        // explicitly allowed, so a default CI `vega verify && ...` cannot be
        // satisfied by a signature-only build.
        const signatureOnlyOk = sig.ok && narOk && sig.scope !== "shared" && !t.found;
        const exitOk = verified || tenantOk || (Boolean(opts.allowSignatureOnly) && signatureOnlyOk);

        if (opts.json) {
          jsonEvent({ hash, ...result, nar: nar ?? undefined, verified, exitOk });
          process.exit(exitOk ? 0 : 1);
        }

        info(star(`Verifying ${pc.bold(result.storePath)}`));
        const rows: [string, string][] = [
          [`Signature (${sig.keyName})`, `${tick(sig.ok)}  ${sig.scope}`],
        ];
        if (sig.scope === "shared") {
          rows.push(["Signed tree head", tick(t.sthVerified)]);
          rows.push([
            "In transparency log",
            t.found ? `${tick(true)}  entry #${t.index} (scanned ${t.scanned})` : pc.red("not found"),
          ]);
          if (t.found) rows.push(["Inclusion proof", `${tick(t.leafHashOk && t.inclusionOk)}`]);
        }
        if (nar) rows.push(["NAR bytes", `${tick(nar.ok)}  ${pc.gray(nar.detail)}`]);
        keyValues(rows);

        if (t.note && sig.scope !== "shared") info(`\n  ${pc.gray(t.note)}`);
        if (verified) {
          success("Verified: signed, in the public log, and the bytes match.");
        } else if (tenantOk) {
          // Tenant-scope verification: signed by this cache's own tenant key and
          // the bytes match. This is a tenant/self check, NOT independent
          // third-party trust; the shared (globally-trusted) tier additionally
          // requires independent reproduction and public transparency-log inclusion.
          success("Verified in your tenant tier: signed by the tenant key and the bytes match.");
          info(
            `  ${pc.gray("Tenant-scope (not third-party): the shared tier adds independent reproduction and public-log inclusion.")}`,
          );
        } else if (signatureOnlyOk) {
          // A valid signature-only result (scoped Vega key or upstream mirror).
          // It is informative, but not full Vega verification.
          warn(
            sig.scope === "upstream"
              ? `Mirrored from ${sig.keyName}; verified by upstream's signature, not by Vega.`
              : "Scoped binding verified by signature only; not in the global transparency log.",
          );
          if (!exitOk) {
            info(`  ${pc.gray("Not full Vega verification. Pass --allow-signature-only to accept this.")}`);
            process.exit(1);
          }
        } else {
          fail("Verification failed. Do not trust this build.");
        }
      },
    );
}
