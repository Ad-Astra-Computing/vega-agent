import pc from "picocolors";
import { requestDeviceCode, pollAccessToken, VEGA_GITHUB_CLIENT_ID } from "../src/agent/device-flow.js";
import { info, fail } from "./ui.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A GitHub user token from the device flow, for one exchange with the control
 * plane. The caller uses it once and never stores it. `retry` is the command
 * named in the message if the code expires.
 */
export async function githubDeviceToken(retry: string): Promise<string> {
  const dc = await requestDeviceCode(VEGA_GITHUB_CLIENT_ID);
  info(`\n  Open ${pc.cyan(dc.verificationUri)} and enter code:  ${pc.bold(dc.userCode)}\n`);
  info("  Waiting for authorization...");
  let interval = dc.interval;
  const deadline = Date.now() + dc.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const r = await pollAccessToken(VEGA_GITHUB_CLIENT_ID, dc.deviceCode);
    if (r.status === "token") return r.accessToken;
    if (r.status === "slow_down") interval = r.interval;
    else if (r.status === "error") fail(`authorization failed: ${r.error}`);
  }
  return fail("device code expired before authorization.", [retry]);
}
