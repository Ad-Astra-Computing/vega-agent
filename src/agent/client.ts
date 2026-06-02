import type { PromotionDecision } from "../trust/policy.js";

/** Attest request body — the narinfo fields the runner claims for an output. */
export interface AttestBody {
  storePath: string;
  url: string;
  compression: string;
  fileHash: string;
  fileSize: number;
  narHash: string;
  narSize: number;
  references: string[];
  deriver?: string;
  /**
   * Flake attribute that produced this output (e.g.
   * `packages.x86_64-linux.hello`). The control plane pairs it with the
   * OIDC-proven flake ref and commit to record reproducible provenance.
   */
  attr?: string;
  /**
   * The builder opted out of publishing their continent (privacy.continent=false
   * in vega.yaml). When set, the control plane records the attestation's
   * continent as unknown rather than deriving it from the request.
   */
  noContinent?: boolean;
}

/** The attest endpoint's response: the full promotion decision plus what was published. */
export interface AttestResult {
  decision: PromotionDecision;
  publishedTenant: boolean;
  publishedShared: boolean;
}

/** Either a fixed bearer (owner credential) or a provider that mints a fresh
 * one per request (OIDC, which must be re-minted so it never expires mid-job). */
/** A bearer token, or a function that mints one. The optional `force` asks a
 * minting source to bypass any cache and produce a fresh token (used to recover
 * from a 401 caused by an expired token mid-run). */
export type TokenSource = string | ((force?: boolean) => Promise<string>);

/** An HTTP response with a non-retryable status, carrying the status so callers
 * can special-case it (e.g. re-mint and retry on 401). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Client for the vega control plane, used by the build agent. Bearer auth is
 * the GitHub OIDC token (or an owner credential). `fetch` is injected so the
 * protocol is testable without a network.
 */
/** Options controlling transient-failure retries. Exposed for testing. */
export interface RetryOptions {
  /** Total attempts including the first (so 1 disables retry). */
  attempts: number;
  /** Base backoff in ms; doubles each attempt, capped at maxDelayMs. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injectable sleeper so tests do not actually wait. */
  sleep: (ms: number) => Promise<void>;
  /** Injectable jitter in [0,1); fixed in tests for determinism. */
  jitter: () => number;
}

// 429 and 5xx are transient: the same request can succeed on a retry. 408 is a
// request-timeout the server invites us to repeat. All agent writes are
// idempotent (attest dedups per attester, R2 PUT is content-addressed, presign
// is stateless), so replaying them is safe.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const DEFAULT_RETRY: RetryOptions = {
  attempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  jitter: Math.random,
};

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly tokenFn: (force?: boolean) => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryOptions;

  constructor(
    baseUrl: string,
    token: TokenSource,
    fetchImpl: typeof fetch = fetch,
    retry: Partial<RetryOptions> = {},
  ) {
    this.baseUrl = baseUrl;
    this.tokenFn = typeof token === "function" ? token : async () => token;
    this.fetchImpl = fetchImpl;
    this.retry = { ...DEFAULT_RETRY, ...retry };
  }

  private async authHeaders(force = false): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.tokenFn(force)}` };
  }

  /**
   * Authenticated request that recovers from an expired token. It attaches the
   * (possibly cached) bearer and runs the normal retry loop; if the response is a
   * 401, the token was rejected, commonly an OIDC JWT that expired mid-run on a
   * long build, so it forces a fresh mint and retries exactly once. A second 401
   * is a real auth failure and propagates. `init.headers` must not already carry
   * an authorization header (this owns it).
   */
  private async authedFetch(url: string, init: RequestInit, label: string): Promise<Response> {
    const withAuth = async (force: boolean): Promise<RequestInit> => ({
      ...init,
      headers: { ...init.headers, ...(await this.authHeaders(force)) },
    });
    try {
      return await this.fetchWithRetry(url, await withAuth(false), label);
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        // Recover with a fresh token, but as a SINGLE attempt: re-entering the
        // full retry loop here could run a second whole retry budget on transient
        // failures. The 401 path is a one-shot re-auth, not another retry budget.
        return await this.fetchOnce(url, await withAuth(true), label);
      }
      throw e;
    }
  }

  /** One request, no retry budget, throwing the same status-only {@link HttpError}
   * as {@link fetchWithRetry} on a non-2xx. Used for the single forced 401 retry. */
  private async fetchOnce(url: string, init: RequestInit, label: string): Promise<Response> {
    const res = await this.fetchImpl(url, init);
    if (!res.ok) throw new HttpError(res.status, `${label} failed: ${res.status}`);
    return res;
  }

  /** Backoff before the next attempt: honor Retry-After, else exponential with
   * full jitter, capped. `attempt` is 1-based (the attempt that just failed). */
  private async backoff(attempt: number, retryAfter: string | null): Promise<void> {
    const ra = retryAfter !== null ? Number(retryAfter) : NaN;
    let ms: number;
    if (Number.isFinite(ra) && ra >= 0) {
      ms = Math.min(this.retry.maxDelayMs, ra * 1000);
    } else {
      const ceil = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
      ms = ceil * this.retry.jitter();
    }
    await this.retry.sleep(ms);
  }

  /**
   * Fetch with retry on transient failures (network errors and retryable HTTP
   * statuses). A non-retryable status throws immediately with a labeled error;
   * exhausting the retry budget rethrows the last failure. The body must be
   * replayable (string or Buffer here), which all callers satisfy.
   */
  private async fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      let res: Response | undefined;
      try {
        res = await this.fetchImpl(url, init);
      } catch (e) {
        lastErr = e; // network-level failure: retry if budget remains
      }
      if (res !== undefined) {
        if (res.ok) return res;
        if (!RETRYABLE_STATUS.has(res.status)) throw new HttpError(res.status, `${label} failed: ${res.status}`);
        lastErr = new Error(`${label} failed: ${res.status}`);
        if (attempt < this.retry.attempts) await this.backoff(attempt, res.headers.get("retry-after"));
      } else if (attempt < this.retry.attempts) {
        await this.backoff(attempt, null);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`${label} failed`);
  }

  /** Ask for a presigned PUT URL for a `nar/...` key. */
  async uploadUrl(narUrl: string): Promise<string> {
    const res = await this.authedFetch(
      `${this.baseUrl}/api/cache/upload-url`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ narUrl }),
      },
      "upload-url",
    );
    const { url } = (await res.json()) as { url: string };
    return url;
  }

  /** Upload NAR bytes directly to R2 via the presigned URL. */
  async putNar(presignedUrl: string, body: BodyInit): Promise<void> {
    await this.fetchWithRetry(presignedUrl, { method: "PUT", body }, "nar upload");
  }

  /** Submit an attestation; returns the promotion decision. */
  async attest(body: AttestBody): Promise<AttestResult> {
    const res = await this.authedFetch(
      `${this.baseUrl}/api/cache/attest`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      "attest",
    );
    return (await res.json()) as AttestResult;
  }

  /**
   * Owner local push (`vega push`): publish an uploaded NAR into the owner's
   * own namespace. The bearer here is an owner credential, not an OIDC token.
   * Unlike `attest`, this produces no shared-tier evidence; the server derives
   * the namespace from the verified credential, never from the client.
   */
  async push(body: AttestBody): Promise<PushResult> {
    // Status only: never echo the response body of an authenticated request
    // (a hostile/buggy server could reflect the credential header into it).
    const res = await this.authedFetch(
      `${this.baseUrl}/api/cache/push`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      "push",
    );
    return (await res.json()) as PushResult;
  }
}

/** The push endpoint's response: the owner namespace the NAR landed in. */
export interface PushResult {
  published: boolean;
  tenant: string;
  substituter: string;
}
