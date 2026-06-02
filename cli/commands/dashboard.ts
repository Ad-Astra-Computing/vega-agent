import type { Command } from "commander";
import { execFile } from "node:child_process";
import { platform } from "node:os";
import { requireCredential, authHeaders, safeError } from "../context.js";
import { star, info, fail } from "../ui.js";

/** Open a URL in the platform browser via execFile, so the URL is passed as a
 * single argument and never through a shell on any platform: `open` on macOS,
 * `xdg-open` on Linux, and `rundll32 url.dll,FileProtocolHandler` on Windows
 * (which takes the URL as data, not a command line). The URL origin is the
 * locally-stored, HTTPS-validated control-plane (see cli/context.ts) and the
 * code is URL-encoded, so it is also not attacker-controlled. */
function openInBrowser(url: string): void {
  const [cmd, args] =
    platform() === "darwin"
      ? ["open", [url]]
      : platform() === "win32"
        ? // rundll32's FileProtocolHandler opens the URL as data, never through a
          // command line, so `cmd`-style metacharacters (& | < > ^ %) cannot be
          // interpreted as command separators the way `cmd /c start` would.
          ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
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
