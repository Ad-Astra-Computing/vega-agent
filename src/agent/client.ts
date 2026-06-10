import { openAsBlob } from "node:fs";
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

// A presigned PUT URL whose validity window has lapsed returns 403 from R2 (the
// signature is past X-Amz-Expires). We detect that client-side from the URL's own
// X-Amz-Date + X-Amz-Expires so we can re-mint and retry, WITHOUT mistaking an
// auth/checksum/object 403 (which happens well within the window) for an expiry.
const PRESIGN_EXPIRY_MARGIN_MS = 60_000;

/** Absolute expiry (ms since epoch) of a SigV4 presigned URL, or null if it lacks
 * the signing params or they are malformed. X-Amz-Date is ISO basic, YYYYMMDDTHHMMSSZ. */
function presignExpiryMs(url: string): number | null {
  let q: URLSearchParams;
  try {
    q = new URL(url).searchParams;
  } catch {
    return null;
  }
  const date = q.get("X-Amz-Date");
  const expires = q.get("X-Amz-Expires");
  if (date === null || expires === null) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
  const secs = Number(expires);
  if (m === null || !Number.isInteger(secs) || secs <= 0) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) + secs * 1000;
}

/** Whether a 403 from a presigned PUT is an EXPIRY (the window lapsed) rather than
 * a genuine auth/checksum/object error, judged from the URL's own validity window. */
function presignLapsed(url: string, now: number): boolean {
  const expiry = presignExpiryMs(url);
  return expiry !== null && now >= expiry - PRESIGN_EXPIRY_MARGIN_MS;
}

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
   * replayable across attempts (a string, Buffer, or file-backed Blob, all of
   * which can be re-read), which every caller satisfies.
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

  /** Ask for a presigned PUT URL for a `nar/...` key. `fileHash`
   * (sha256:<nixbase32>) is required: it binds the presigned PUT to that checksum,
   * so R2 verifies the upload and stores its SHA-256, letting attest verify without
   * a Worker re-hash (which 503s on multi-GB NARs). The companion {@link putNar}
   * must send the matching `x-amz-checksum-sha256` header. */
  async uploadUrl(narUrl: string, fileHash: string): Promise<string> {
    const res = await this.authedFetch(
      `${this.baseUrl}/api/cache/upload-url`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ narUrl, fileHash }),
      },
      "upload-url",
    );
    const { url } = (await res.json()) as { url: string };
    return url;
  }

  /** Upload a NAR directly to R2 via the presigned URL. Callers pass a file-backed
   * Blob (see openAsBlob) so the compressed NAR streams from disk rather than being
   * buffered in memory; the Blob is re-readable, so the retry path still works.
   * `sha256Base64` must equal the value the presigned URL was signed with (see
   * {@link uploadUrl}); R2 rejects the PUT if the sent bytes disagree. */
  async putNar(presignedUrl: string, body: BodyInit, sha256Base64: string): Promise<void> {
    await this.fetchWithRetry(
      presignedUrl,
      { method: "PUT", body, headers: { "x-amz-checksum-sha256": sha256Base64 } },
      "nar upload",
    );
  }

  /**
   * Mint a presigned PUT and upload the NAR, re-minting ONCE if the URL's validity
   * window lapsed before the upload finished. A multi-GB NAR can outrun the presign
   * TTL, after which R2 403s the expired URL; a fresh URL lets the retry succeed. A
   * 403 that is NOT an expiry (auth, checksum mismatch, object error, judged from
   * the URL's own window) is surfaced, not retried, so real failures are never
   * masked. The NAR streams from disk as a fresh file-backed Blob per attempt.
   */
  async uploadNar(narUrl: string, fileHash: string, file: string, sha256Base64: string): Promise<void> {
    const url = await this.uploadUrl(narUrl, fileHash);
    try {
      await this.putNar(url, await openAsBlob(file), sha256Base64);
      return;
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 403 || !presignLapsed(url, Date.now())) throw e;
    }
    const fresh = await this.uploadUrl(narUrl, fileHash);
    await this.putNar(fresh, await openAsBlob(file), sha256Base64);
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
