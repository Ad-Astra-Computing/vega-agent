import type { Command } from "commander";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { createZstdDecompress } from "node:zlib";
import { Readable } from "node:stream";
import pc from "picocolors";
import { DEFAULT_CONTROL_PLANE, assertSafeControlPlane, controlPlaneFor } from "../context.js";
import { star, info, success, warn, fail, keyValues, jsonEvent } from "../ui.js";
import { parsePublicKey } from "../../src/nix/signing.js";
import { verifyNarHash } from "../../src/nix/verify.js";
import { parseNarInfo } from "../../src/nix/narinfo.js";
import type { NixPublicKey } from "../../src/nix/types.js";
import { verifyBuild, fullyVerified, type Fetcher, type VerifyResult } from "../verify-core.js";

const execFileP = promisify(execFile);
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

/** Collect trusted-public-keys Nix already trusts: `nix config show`, then the
 * config files. These are keys the user has chosen to trust, so verifying
 * against them is meaningful (unlike a key fetched from the cache itself). */
async function trustedKeys(): Promise<Map<string, NixPublicKey>> {
  const out = new Map<string, NixPublicKey>();
  const add = (raw: string) => {
    for (const tok of raw.split(/\s+/)) {
      const t = tok.trim();
      if (!t.includes(":")) continue;
      try {
        const pk = parsePublicKey(t);
        out.set(pk.name, pk);
      } catch {
        /* skip malformed */
      }
    }
  };
  try {
    const { stdout } = await execFileP("nix", ["config", "show", "trusted-public-keys"]);
    add(stdout);
  } catch {
    /* nix absent or older: fall back to files */
  }
  for (const path of ["/etc/nix/nix.conf", `${homedir()}/.config/nix/nix.conf`]) {
    try {
      const text = await readFile(path, "utf8");
      for (const line of text.split("\n")) {
        const m = /^\s*(?:extra-)?trusted-public-keys\s*=\s*(.+)$/.exec(line);
        if (m) add(m[1]!);
      }
    } catch {
      /* file absent */
    }
  }
  return out;
}

/** Resolve the key to verify against, in order: explicit flag, then a
 * trusted-public-keys entry whose name matches the narinfo's signature. */
async function resolveKey(sigNames: string[], flag?: string): Promise<NixPublicKey> {
  if (flag) {
    try {
      return parsePublicKey(flag);
    } catch {
      fail(`--public-key is not a valid '<name>:<base64>' key`);
    }
  }
  const trusted = await trustedKeys();
  for (const name of sigNames) {
    const pk = trusted.get(name);
    if (pk) return pk;
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

/** Re-derive the uncompressed NAR hash and compare to the signed claim. */
async function checkNar(
  cacheUrl: string,
  url: string,
  compression: string,
  narHash: string,
): Promise<{ ok: boolean; detail: string }> {
  if (compression !== "zstd" && compression !== "none") {
    return { ok: false, detail: `unsupported compression '${compression}' for local check` };
  }
  const res = await fetch(`${cacheUrl}/${url}`);
  if (!res.ok || res.body === null) return { ok: false, detail: `NAR fetch failed (HTTP ${res.status})` };
  let stream: ReadableStream<Uint8Array>;
  if (compression === "zstd") {
    const compressed = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    stream = Readable.toWeb(compressed.pipe(createZstdDecompress())) as ReadableStream<Uint8Array>;
  } else {
    stream = res.body;
  }
  const r = await verifyNarHash(narHash, stream);
  return r.ok
    ? { ok: true, detail: r.actual }
    : { ok: false, detail: `signed ${r.expected}, content ${r.actual}` };
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
        const publicKey = await resolveKey(sigNames, opts.publicKey);

        const fetcher: Fetcher = (path) => fetch(`${cacheUrl}${path}`);
        const result: VerifyResult = await verifyBuild({
          fetcher,
          info: narInfo,
          publicKey,
          sharedKeyName: SHARED_KEY_NAME,
          maxScan: opts.maxScan,
        });

        const nar = opts.nar
          ? await checkNar(cacheUrl, narInfo.url, narInfo.compression, narInfo.narHash)
          : null;

        const sig = result.signature;
        const t = result.transparency;
        const narOk = nar === null || nar.ok;
        const verified = fullyVerified(result) && narOk;
        // A valid scoped/upstream signature is a real result but NOT full Vega
        // verification; it only yields exit 0 when explicitly allowed, so a CI
        // `vega verify && ...` cannot be satisfied by a signature-only build.
        const signatureOnlyOk = sig.ok && narOk && sig.scope !== "shared" && !t.found;
        const exitOk = verified || (Boolean(opts.allowSignatureOnly) && signatureOnlyOk);

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
