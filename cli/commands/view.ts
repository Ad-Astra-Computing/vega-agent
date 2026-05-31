import type { Command } from "commander";
import pc from "picocolors";
import { requireCredential, authHeaders, safeError } from "../context.js";
import { star, info, fail, jsonEvent } from "../ui.js";

interface ViewToken {
  token: string;
  substituter: string;
  publicKey: string;
  sharedKey: string;
}

const NIXOS_CACHE = "https://cache.nixos.org";
const NIXOS_KEY = "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=";

// A Nix trusted-public-key: `<name>:<base64>`, no whitespace or control chars.
const NIX_KEY = /^[A-Za-z0-9._-]+:[A-Za-z0-9+/]+=*$/;
// The substituter path the server returns is always `/u/<token>`.
const VIEW_PATH = /^\/u\/[A-Za-z0-9_-]+$/;

/** Reject a control-plane response that could inject extra nix.conf lines. */
function validateView(v: ViewToken): void {
  if (typeof v.substituter !== "string" || !VIEW_PATH.test(v.substituter)) {
    fail("control plane returned an unexpected substituter path; refusing to print config.");
  }
  for (const k of [v.publicKey, v.sharedKey]) {
    if (typeof k !== "string" || !NIX_KEY.test(k)) {
      fail("control plane returned a malformed public key; refusing to print config.");
    }
  }
}

export function registerView(program: Command): void {
  program
    .command("view")
    .description("Print the Nix substituter config for your personalized trust view")
    .option("--format <fmt>", "nix-conf | json", "nix-conf")
    .action(async (opts: { format: string }) => {
      const cred = await requireCredential();
      const res = await fetch(`${cred.url}/api/view/token`, {
        method: "POST",
        headers: authHeaders(cred),
      });
      if (!res.ok) fail(`could not get your view (${await safeError(res)})`);
      const v = (await res.json()) as ViewToken;
      validateView(v);
      const base = `${cred.url}${v.substituter}`;
      const substituters = `${base} ${NIXOS_CACHE}`;
      const keys = `${v.publicKey} ${v.sharedKey} ${NIXOS_KEY}`;

      if (opts.format === "json") {
        jsonEvent({ substituter: base, viewKey: v.publicKey, sharedKey: v.sharedKey, substituters, trustedPublicKeys: keys });
        return;
      }
      if (opts.format !== "nix-conf") fail(`unknown --format: ${opts.format}`, ["vega view --format nix-conf"]);

      info(star(`Vega view for ${pc.bold(cred.login)}`));
      info("");
      info("Add to nix.conf (or your NixOS/nix-darwin substituters + trusted-public-keys):\n");
      info(`  extra-substituters = ${base}`);
      info(`  extra-trusted-public-keys = ${v.publicKey} ${v.sharedKey}`);
      info("");
      info(pc.gray("This one substituter serves, under their honest provenance:"));
      info(`  ${pc.green("shared-reproduced")}  builds Vega independently reproduced`);
      info(`  ${pc.cyan("social")}             builds from owners your trust graph resolves`);
      info(`  ${pc.blue("tenant")}             builds from your own namespace`);
      info(pc.gray("\nThe view key is yours alone; a binding signed for you is rejected for anyone else."));
    });
}
