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

/**
 * Statuses worth asking again about. A 5xx or a gateway timeout is the token
 * service having a moment; 408 and 429 are it asking us to wait. A 401 or 403
 * means the job does not have `id-token: write`, which will not change however
 * many times we ask, and retrying it only buries the real cause.
 */
function isTransient(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

const ATTEMPTS = 4;
const BACKOFF_MS = [500, 1000, 2000];
// Every pipeline worker shares one token service, so a fixed wait sends all of
// them back at the same instant after a single outage.
const JITTER = 0.5;

export async function fetchActionsOidcToken(
  env: ActionsOidcEnv,
  audience: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 60_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  random: () => number = Math.random,
): Promise<string> {
  if (!env.requestUrl || !env.requestToken) {
    throw new Error(
      "missing ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN — set `permissions: id-token: write`",
    );
  }
  const url = new URL(env.requestUrl);
  url.searchParams.set("audience", audience);
  let last: Error | undefined;
  const seen: string[] = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const base = BACKOFF_MS[attempt - 1]!;
      await sleep(Math.round(base * (1 - JITTER + 2 * JITTER * random())));
    }
    let res: Response;
    try {
      // Deadline per attempt: the token service is shared across every pipeline
      // worker (the provider caches one mint at a time), so a mint that hangs
      // would stall ALL of them at once with no output. Retrying does not
      // relax that; each try still has to answer inside it.
      res = await fetchImpl(url, {
        headers: { authorization: `Bearer ${env.requestToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // No answer at all: a dropped connection or the deadline above. A publish
      // re-mints on demand, so giving up here throws away however long the
      // build and upload already took.
      last = e instanceof Error ? e : new Error(String(e));
      seen.push(last.message);
      continue;
    }
    if (res.ok) {
      const { value } = (await res.json()) as { value?: string };
      if (typeof value !== "string" || value === "") {
        throw new Error("OIDC token response had no `value`");
      }
      return value;
    }
    last = new Error(`OIDC token request failed: ${res.status}`);
    seen.push(String(res.status));
    if (!isTransient(res.status)) throw last;
  }
  // Every attempt, not just the last: an outage should read as one failure with
  // a history rather than a single mysterious status.
  throw new Error(`OIDC token request failed after ${ATTEMPTS} attempts: ${seen.join(", ")}`);
}
