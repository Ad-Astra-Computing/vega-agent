/**
 * Trusted-public-key resolution shared by `vega verify` and the MCP server.
 *
 * The verification key MUST come from a source the user already trusts (their
 * nix.conf trusted-public-keys, or an explicit flag) — NEVER from the cache
 * itself, or a hostile cache could supply both a forged signature and the key
 * that "verifies" it. So this only reads keys Nix is already configured to trust.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { parsePublicKey } from "../src/nix/signing.js";
import type { NixPublicKey } from "../src/nix/types.js";

const execFileP = promisify(execFile);

/** Collect the keys Nix already trusts: `nix config show`, then the config files. */
export async function trustedKeys(): Promise<Map<string, NixPublicKey>> {
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

/** First trusted key whose name matches one of the narinfo's signature names. */
export function pickTrustedKey(
  trusted: Map<string, NixPublicKey>,
  sigNames: string[],
): NixPublicKey | null {
  for (const name of sigNames) {
    const pk = trusted.get(name);
    if (pk) return pk;
  }
  return null;
}
