/**
 * Fetch a GitHub Actions OIDC token from the runner-local token service. On a
 * GitHub-hosted runner with `permissions: id-token: write`, the Actions runtime
 * exposes `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`.
 * We exchange them for a JWT scoped to `audience` (the vega control plane).
 */
export interface ActionsOidcEnv {
  requestUrl?: string;
  requestToken?: string;
}

export async function fetchActionsOidcToken(
  env: ActionsOidcEnv,
  audience: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!env.requestUrl || !env.requestToken) {
    throw new Error(
      "missing ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN — set `permissions: id-token: write`",
    );
  }
  const url = new URL(env.requestUrl);
  url.searchParams.set("audience", audience);
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${env.requestToken}` },
  });
  if (!res.ok) {
    throw new Error(`OIDC token request failed: ${res.status}`);
  }
  const { value } = (await res.json()) as { value?: string };
  if (typeof value !== "string" || value === "") {
    throw new Error("OIDC token response had no `value`");
  }
  return value;
}
