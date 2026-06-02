import type { Command } from "commander";
import { execFile } from "node:child_process";
import { platform } from "node:os";
import { requireCredential, authHeaders, safeError } from "../context.js";
import { star, info, fail } from "../ui.js";

/** Open a URL in the platform browser via execFile (no shell, so the URL is a
 * single argument and cannot be interpreted as a command). */
function openInBrowser(url: string): void {
  const [cmd, args] =
    platform() === "darwin"
      ? ["open", [url]]
      : platform() === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  execFile(cmd as string, args as string[], (err) => {
    if (err) info(`Could not open a browser automatically. Visit:\n  ${url}`);
  });
}

export function registerDashboard(program: Command): void {
  program
    .command("dashboard")
    .description("Open your private Vega dashboard in the browser (uses your existing login)")
    .option("--no-open", "print the sign-in URL instead of opening a browser")
    .action(async (opts: { open: boolean }) => {
      const cred = await requireCredential();
      // Exchange the long-lived owner credential for a short-lived login code; the
      // credential never leaves the CLI, only the 60s code rides the URL.
      const res = await fetch(`${cred.url}/owner/session-code`, {
        method: "POST",
        headers: authHeaders(cred),
      });
      if (!res.ok) fail(`could not start a dashboard session (${await safeError(res)})`);
      const { code } = (await res.json()) as { code?: unknown };
      if (typeof code !== "string" || code === "") fail("control plane returned no login code.");
      // Build the sign-in URL from the trusted, stored control-plane origin (not a
      // server-supplied URL), so we never open an attacker-chosen location.
      const url = `${cred.url}/owner/login?code=${encodeURIComponent(code as string)}`;
      if (opts.open === false) {
        info(url);
        return;
      }
      star(`Opening your dashboard...\n  ${url}`);
      openInBrowser(url);
    });
}
