import type { Command } from "commander";
import pc from "picocolors";
import { DEFAULT_CONTROL_PLANE, assertSafeControlPlane, controlPlaneFor } from "../context.js";
import { star, info, success, warn, fail, keyValues, jsonEvent } from "../ui.js";
import { parsePublicKey } from "../../src/nix/signing.js";
import { parseNarInfo } from "../../src/nix/narinfo.js";
import { checkNarHash } from "../nar-check.js";
import type { NixPublicKey } from "../../src/nix/types.js";
import { trustedKeys, pickTrustedKey } from "../keys.js";
import { verifyBuild, fullyVerified, withRetry, type Fetcher, type VerifyResult } from "../verify-core.js";
import { boundedFetcher, revocationAuthority } from "../mcp/runtime.js";

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
    // Each segment must start alphanumeric, so "." / ".." path segments (which
    // URL normalization would collapse to escape /tenant/) are rejected.
    return (
      /^\/tenant\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(p) ||
      /^\/tenant\/owner:[0-9]+$/.test(p)
    );
  } catch {
    return false;
  }
}

/** A well-formed tenant identifier: `<owner>/<repo>` or `owner:<id>`. Each path
 * segment must start alphanumeric, so a crafted "." / ".." segment cannot
 * collapse under URL normalization and escape the /tenant/ route. */
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$|^owner:[0-9]+$/;

/** When a build is not in the shared cache, ask the cache's /api/status which
 * tenant(s) hold it and fetch that tenant's narinfo, so a bare `vega verify`
 * resolves a tenant-only build. Returns null if no single tenant holds it; if
 * several do, it exits with the exact per-tenant commands to disambiguate. */
export async function discoverTenant(
  baseUrl: string,
  hash: string,
): Promise<{ url: string; narText: string } | null> {
  let tenants: string[];
  try {
    const sres = await fetch(`${baseUrl}/api/status/${hash}`);
    if (!sres.ok) return null;
    const body = (await sres.json()) as { tenants?: unknown };
    tenants = Array.isArray(body.tenants)
      ? [
          ...new Set(
            body.tenants.filter((t): t is string => typeof t === "string" && TENANT_ID.test(t)),
          ),
        ].slice(0, 50) // dedupe and bound, so a hostile response cannot blow up
      : [];
  } catch {
    return null;
  }
  if (tenants.length === 0) return null;
  if (tenants.length > 1) {
    fail(
      `${hash} is cached in multiple tenants; verify a specific one:`,
      tenants.map((t) => `  vega verify ${hash} --url ${baseUrl}/tenant/${t}`),
    );
  }
  const url = `${baseUrl}/tenant/${tenants[0]}`;
  const nres = await fetch(`${url}/${hash}.narinfo`);
  if (!nres.ok) return null;
  return { url, narText: await nres.text() };
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

/**
 * The key that authenticates the revocation list: the user's pinned shared key,
 * or a `--public-key` they passed that IS the shared key.
 *
 * The flag counts here only when it names the shared key exactly. That is a
 * deliberate trust decision the user typed, and it is the flow this command's
 * own "no trusted key" message recommends, so refusing it would have the CLI
 * recommend something that then reports every build's revocation as unknown.
 * A flag naming any OTHER key is ignored: it says which key a BUILD should
 * carry, and must never become the authority on a global list.
 */
export async function sharedKeyForList(
  verifyingKey: NixPublicKey,
  flag?: string,
): Promise<NixPublicKey | null> {
  const pinned = pickTrustedKey(await trustedKeys(), [SHARED_KEY_NAME]);
  if (pinned) return pinned;
  // Truthiness, matching resolveKey, NOT `!== undefined`. An empty flag (a
  // `--public-key "$VAR"` whose variable is unset) is not a key the user typed:
  // resolveKey ignores it too and, on a tenant URL, falls back to the key the
  // CACHE publishes. Accepting that here would let a hostile origin serve a
  // self-made key named vega-cache-1, sign its own empty revocation list with
  // it, and reach a full green "Verified" on a root the user never chose.
  if (!flag) return null;
  return verifyingKey.name === SHARED_KEY_NAME ? verifyingKey : null;
}

/**
 * Whether `vega verify` should exit 0, as a pure decision.
 *
 * Extracted because it was inline in the command action and therefore untested,
 * and a revoked tenant build shipped exiting 0 as a result: the JSON path
 * honoured the decision and the human path fell off the end of a success branch.
 * The shell only sees this function's answer, so this is where it belongs.
 */
export function verifyExitOk(
  r: VerifyResult,
  o: { narOk: boolean; narChecked: boolean; tenantScope: boolean; allowSignatureOnly?: boolean },
): boolean {
  // An explicit revocation overrides every route to success. The weaker tiers
  // below deliberately accept weaker evidence, but "Vega withdrew this" is not
  // weaker evidence, it is a different answer, and it applies to a tenant
  // binding as much as a shared one.
  if (r.revocation.revoked === true) return false;
  if (fullyVerified(r) && o.narOk) return true;
  // A tenant scope (--url .../tenant/<owner>/<repo>) is an explicit request to
  // verify a tenant build: a Vega tenant-key signature plus actually-checked
  // bytes is the success criterion there, never an upstream-mirror signature.
  if (o.tenantScope && r.signature.ok && r.signature.scope === "scoped" && o.narChecked) return true;
  // A valid scoped/upstream signature is a real result but NOT full Vega
  // verification, so outside a tenant scope it needs an explicit opt-in and a
  // default CI `vega verify && ...` cannot be satisfied by one.
  return (
    Boolean(o.allowSignatureOnly) &&
    r.signature.ok &&
    o.narOk &&
    r.signature.scope !== "shared" &&
    !r.transparency.found
  );
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
        let cacheUrl = assertSafeControlPlane(controlPlaneFor(opts.url));
        const hash = extractHash(target);

        // Fetch the narinfo ONCE; this single snapshot drives key resolution,
        // signature + log verification, and the NAR re-derivation, so a cache
        // cannot serve one narinfo to be verified and another to be hashed.
        let narText: string;
        const res = await fetch(`${cacheUrl}/${hash}.narinfo`);
        if (res.ok) {
          narText = await res.text();
        } else if (res.status === 404 && !isTenantScope(cacheUrl)) {
          // Not in the shared scope: discover which tenant holds it (via the
          // cache's /api/status) and verify against that tenant scope, so a bare
          // `vega verify <hash>` works for a tenant-only build, not just shared.
          const found = await discoverTenant(cacheUrl, hash);
          if (found === null) fail(`no build found for ${hash} (HTTP ${res.status})`);
          cacheUrl = found.url;
          narText = found.narText;
          info(`  ${pc.gray(`Not in the shared cache; verifying the tenant build at ${cacheUrl}`)}`);
        } else {
          fail(`no build found for ${hash} (HTTP ${res.status})`);
        }
        const narInfo = parseNarInfo(narText);
        // The answer must be about the path that was asked about. Nothing else
        // pins that: a cache asked for a revoked hash could return a different
        // validly-signed, logged, unrevoked narinfo, and every check below would
        // pass for THAT path while the caller believes it verified this one.
        if (!narInfo.storePath.startsWith(`/nix/store/${hash}-`)) {
          fail(
            `the cache answered for ${narInfo.storePath}, which is not the path ${hash} was asked about`,
          );
        }
        const sigNames = narInfo.sigs.map((s) => s.slice(0, s.indexOf(":")).trim()).filter(Boolean);
        const publicKey = await resolveKey(cacheUrl, sigNames, opts.publicKey);

        // Same hardened fetcher the MCP path uses: per-request timeout, a size
        // bound against a hostile giant body, and retry on a transient 5xx so a
        // single failed request mid-log-scan (up to thousands of entries) does not
        // abort verify.
        const fetcher: Fetcher = withRetry(boundedFetcher(cacheUrl, 4 * 1024 * 1024));
        // Signed by the shared key regardless of tier, and checked against one
        // the user already trusts, so it comes from their trusted keys rather
        // than the narinfo's signers. The constructor derives the origin.
        const result: VerifyResult = await verifyBuild({
          fetcher,
          revocation: revocationAuthority(cacheUrl, await sharedKeyForList(publicKey, opts.publicKey)),
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
        const revoked = result.revocation.revoked === true;
        const exitOk = verifyExitOk(result, {
          narOk,
          narChecked,
          tenantScope: isTenantScope(cacheUrl),
          ...(opts.allowSignatureOnly !== undefined ? { allowSignatureOnly: opts.allowSignatureOnly } : {}),
        });

        if (opts.json) {
          jsonEvent({ hash, ...result, nar: nar ?? undefined, verified, exitOk });
          process.exit(exitOk ? 0 : 1);
        }

        info(star(`Verifying ${pc.bold(result.storePath)}`));
        const rows: [string, string][] = [
          [`Signature (${sig.keyName})`, `${tick(sig.ok)}  ${sig.scope}`],
        ];
        // Always shown. A reader who does not see the row cannot tell a binding
        // that stands from one nobody asked about.
        rows.push([
          "Revocation",
          result.revocation.revoked === true
            ? `${tick(false)}  REVOKED${result.revocation.reason ? `: ${result.revocation.reason}` : ""}`
            : result.revocation.revoked === false
              ? `${tick(true)}  not revoked`
              : `${tick(false)}  unknown (${result.revocation.note ?? "not checked"})`,
        ]);
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
        // First, and on its own: a withdrawn binding is not a weaker pass, and
        // the tenant branch below would otherwise print "Verified in your tenant
        // tier" over the top of it.
        if (revoked) {
          fail(
            result.revocation.reason
              ? `Vega has revoked this build: ${result.revocation.reason}. Do not trust it.`
              : "Vega has revoked this build. Do not trust it.",
          );
        }
        if (verified) {
          success(
            nar !== null
              ? "Verified: signed, in the public log, and the bytes match."
              : "Verified: signed and in the public log (NAR bytes not checked: --no-nar).",
          );
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
        // Backstop. The branches above each decide what to PRINT; this decides
        // what the shell sees, once, for all of them. A branch that printed a
        // success it should not have (a revoked tenant build did exactly that)
        // cannot reach exit 0 by falling off the end.
        if (!exitOk) process.exit(1);
      },
    );
}
