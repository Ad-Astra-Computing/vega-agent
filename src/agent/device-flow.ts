/**
 * GitHub device flow for `vega login` (the owner lane). A public client: only
 * the Client ID is used, never a secret. Pure request/response logic here; the
 * polling loop and credential storage live in the CLI (../../agent/login.ts).
 *
 * The user runs `vega login`, authorizes the Vega Cache app at the shown URL,
 * and the CLI exchanges the device code for a short-lived GitHub user token,
 * which it sends once to Vega's enrollment endpoint (it is never stored).
 */

/** The Vega Cache GitHub App client ID (public). */
export const VEGA_GITHUB_CLIENT_ID = "Iv23liYWrhwLxxmY8iK3";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds until the device code expires. */
  expiresIn: number;
  /** Minimum seconds between polls. */
  interval: number;
}

/** Start the device flow; returns the code and URL to show the user. */
export async function requestDeviceCode(
  clientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCode> {
  const res = await fetchImpl(DEVICE_CODE_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!res.ok) throw new Error(`device code request failed: ${res.status}`);
  const j = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };
  return {
    deviceCode: j.device_code,
    userCode: j.user_code,
    verificationUri: j.verification_uri,
    expiresIn: j.expires_in,
    interval: j.interval,
  };
}

export type PollResult =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "token"; accessToken: string }
  | { status: "error"; error: string };

/** Poll once for the user access token after the user authorizes. */
export async function pollAccessToken(
  clientId: string,
  deviceCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PollResult> {
  const res = await fetchImpl(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: GRANT }),
  });
  const j = (await res.json()) as { access_token?: string; error?: string; interval?: number };
  if (typeof j.access_token === "string" && j.access_token !== "") {
    return { status: "token", accessToken: j.access_token };
  }
  if (j.error === "authorization_pending") return { status: "pending" };
  if (j.error === "slow_down") return { status: "slow_down", interval: j.interval ?? 5 };
  return { status: "error", error: j.error ?? "unknown" };
}
