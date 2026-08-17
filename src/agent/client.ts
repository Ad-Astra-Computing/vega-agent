import { openAsBlob } from "node:fs";
import { envSeconds } from "./env.js";
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
   * Subflake directory for a monorepo whose flake lives in a subdirectory
   * (`?dir=<dir>`), supplied with `attr` for the top-level output. The control
   * plane sanitizes it and, for a canonical github build, reproduces the output as
   * `github:<repository>/<rev>?dir=<dir>`. Absent for a root flake.
   */
  dir?: string;
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
  /** Per-attempt deadline for control-plane requests, ms. */
  requestTimeoutMs: number;
  /**
   * How long a NAR PUT may move NO bytes before it is aborted and retried, ms.
   *
   * Uploads are bounded by INACTIVITY, not by total duration. A wall-clock
   * allowance cannot tell a stalled upload from a slow one, so it has to be sized
   * for the slowest legitimate case, and a stall then burns that whole allowance
   * before any retry fires. Sizing it by payload made that worse the larger the
   * NAR: a 5 GB upload got an 85 minute attempt, so a wedged connection consumed
   * a 90 minute CI job and the retry never ran. Inactivity separates the two
   * cases directly: a progressing upload runs as long as it needs, a silent one
   * fails fast and retries.
   */
  uploadStallMs: number;
  /**
   * Absolute per-attempt cap for the NAR PUT, ms. 0 disables it, which is the
   * default: any fixed cap eventually aborts a large upload that is progressing
   * fine (5 GB at 1 MiB/s legitimately takes 85 minutes, and each retry restarts
   * from zero because the PUT is not resumable). Kept as an opt-in escape hatch.
   */
  uploadTimeoutMs: number;
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

// Every attempt runs under a deadline. Without one, a connection that stalls
// (a PUT wedged mid-body, a response that never arrives) hangs its pipeline
// worker FOREVER: undici's header/body timers do not cover a stalled request
// upload, so nothing ever fires. Observed in production as an upload step that
// went silent mid-closure until the job's 90-minute cap killed it, with no
// error and no retry. A deadline turns the stall into a retryable failure.
// The NAR PUT gets its own, much larger budget: multi-GB uploads on a slow
// link are legitimately slow, and aborting one too early would loop forever.
const DEFAULT_RETRY: RetryOptions = {
  attempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  jitter: Math.random,
  requestTimeoutMs: envSeconds("VEGA_HTTP_TIMEOUT_SECONDS", 120) * 1000,
  // Generous enough that R2 finalizing a multi-GB object (it verifies the
  // checksum before responding) is never mistaken for a stall, and still an
  // order of magnitude below the CI step caps these jobs run under.
  uploadStallMs: envSeconds("VEGA_UPLOAD_STALL_SECONDS", 300) * 1000,
  uploadTimeoutMs: envSeconds("VEGA_UPLOAD_TIMEOUT_SECONDS", 0) * 1000,
};

/**
 * The same Blob, whose `stream()` reports each chunk as undici reads it.
 *
 * This is how an upload is observed at all. `fetch` exposes no progress events,
 * but it does pull the request body through `Blob.stream()`, so wrapping that
 * one method turns "bytes leaving this process" into something a timer can key
 * on. The wrapper keeps `size`, so undici still sends Content-Length and the
 * request stays a plain sized PUT: handing `fetch` a bare ReadableStream instead
 * would switch it to chunked transfer encoding, which a presigned S3/R2 PUT
 * rejects. Every call builds a fresh underlying stream, so the body stays
 * replayable across retry attempts.
 */
function countingBlob(blob: Blob, onChunk: (bytes: number) => void): Blob {
  const wrapper = {
    size: blob.size,
    type: blob.type,
    stream(): ReadableStream<Uint8Array> {
      const reader = blob.stream().getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            // Report the end of the body as progress too: what follows is the
            // wait for the server's response, which must get its own fresh
            // window rather than inheriting whatever is left of the last chunk's.
            onChunk(0);
            controller.close();
            return;
          }
          onChunk(value.byteLength);
          controller.enqueue(value);
        },
        cancel(reason) {
          void reader.cancel(reason);
        },
      });
    },
    arrayBuffer: () => blob.arrayBuffer(),
    text: () => blob.text(),
    slice: (...args: Parameters<Blob["slice"]>) => blob.slice(...args),
  };
  // undici brand-checks the body, so the wrapper has to present as a Blob.
  Object.setPrototypeOf(wrapper, Blob.prototype);
  return wrapper as unknown as Blob;
}

/** Reports bytes moved so far for one upload, and its total size. */
export type UploadProgress = (movedBytes: number, totalBytes: number) => void;

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
  private async authedFetch<T = Response>(
    url: string,
    init: RequestInit,
    label: string,
    consume?: (res: Response) => Promise<T>,
  ): Promise<T> {
    const withAuth = async (force: boolean): Promise<RequestInit> => ({
      ...init,
      headers: { ...init.headers, ...(await this.authHeaders(force)) },
    });
    try {
      return await this.fetchWithRetry(url, await withAuth(false), label, undefined, consume);
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        // Recover with a fresh token, but as a SINGLE attempt: re-entering the
        // full retry loop here could run a second whole retry budget on transient
        // failures. The 401 path is a one-shot re-auth, not another retry budget.
        return await this.fetchOnce(url, await withAuth(true), label, consume);
      }
      throw e;
    }
  }

  /** One request, no retry budget, throwing the same status-only {@link HttpError}
   * as {@link fetchWithRetry} on a non-2xx. Used for the single forced 401 retry. */
  private async fetchOnce<T = Response>(
    url: string,
    init: RequestInit,
    label: string,
    consume?: (res: Response) => Promise<T>,
  ): Promise<T> {
    try {
      const res = await this.fetchImpl(url, this.withDeadline(init, this.retry.requestTimeoutMs));
      if (!res.ok) throw new HttpError(res.status, `${label} failed: ${res.status}`);
      return consume === undefined ? (res as unknown as T) : await consume(res);
    } catch (e) {
      throw this.labelTimeout(e, label, this.retry.requestTimeoutMs);
    }
  }

  /** The init with a fresh per-attempt abort deadline attached. A new signal per
   * attempt, not one shared across the retry loop: a shared signal would count
   * backoff sleeps against the budget and abort every later attempt at once. */
  private withDeadline(init: RequestInit, timeoutMs: number): RequestInit {
    // AbortSignal.timeout requires integer milliseconds and throws ERR_OUT_OF_RANGE
    // on a fraction. The upload deadline scales with payload size
    // ((bytes / MiB) * 1000), which is a float for any NAR that is not a whole
    // number of mebibytes, so a large NAR (a ~1.9 GB closure) crashed the publish
    // at the end with "delay ... must be an integer" after the build and most of
    // the paths had already succeeded. Round up: the deadline only ever needs to
    // be at least this long, and this is the single point every deadline flows
    // through.
    return { ...init, signal: AbortSignal.timeout(Math.ceil(timeoutMs)) };
  }

  /**
   * Init whose deadline is INACTIVITY rather than total duration, for uploads.
   *
   * The clock restarts on every chunk undici pulls out of the body, and once more
   * when the body is exhausted so the wait for the server's response gets a full
   * window of its own. `capMs > 0` adds an absolute backstop for the pathological
   * case of a connection that dribbles just enough to keep resetting the clock.
   *
   * The caller must call `dispose` when the attempt settles, or the pending timer
   * keeps a handle alive until it fires.
   */
  private withStall(
    init: RequestInit,
    stallMs: number,
    capMs: number,
    onProgress?: UploadProgress,
  ): { init: RequestInit; dispose: () => void } {
    const control = new AbortController();
    const total = init.body instanceof Blob ? init.body.size : 0;
    let moved = 0;
    let idle: NodeJS.Timeout | undefined;
    let cap: NodeJS.Timeout | undefined;
    const give = (why: string): void => control.abort(new DOMException(why, "TimeoutError"));
    const arm = (): void => {
      if (idle !== undefined) clearTimeout(idle);
      idle = setTimeout(() => give(`stalled: no bytes moved for ${Math.round(stallMs / 1000)}s`), Math.ceil(stallMs));
      idle.unref();
    };
    arm();
    if (capMs > 0) {
      cap = setTimeout(() => give(`timed out after ${Math.round(capMs / 1000)}s`), Math.ceil(capMs));
      cap.unref();
    }
    const body =
      init.body instanceof Blob
        ? countingBlob(init.body, (n) => {
            moved += n;
            arm();
            onProgress?.(moved, total);
          })
        : init.body;
    return {
      init: { ...init, body, signal: control.signal },
      dispose: () => {
        if (idle !== undefined) clearTimeout(idle);
        if (cap !== undefined) clearTimeout(cap);
      },
    };
  }

  /** A deadline abort relabeled with the request it killed; other errors pass. */
  private labelTimeout(e: unknown, label: string, timeoutMs: number): unknown {
    if (!(e instanceof DOMException) || (e.name !== "TimeoutError" && e.name !== "AbortError")) return e;
    // A stall abort carries its own diagnosis ("stalled: no bytes moved for
    // 300s"), which says far more than a duration; AbortSignal.timeout's own
    // TimeoutError does not, so that one keeps the generic wording.
    const why = /^(stalled|timed out)/.test(e.message)
      ? e.message
      : `timed out after ${Math.round(timeoutMs / 1000)}s`;
    return new Error(`${label} ${why}`);
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
  private async fetchWithRetry<T = Response>(
    url: string,
    init: RequestInit,
    label: string,
    timeoutMs = this.retry.requestTimeoutMs,
    consume?: (res: Response) => Promise<T>,
    stall?: { stallMs: number; capMs: number; onProgress?: UploadProgress },
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      let res: Response | undefined;
      // A fresh deadline AND a fresh body per attempt: the stall clock must not
      // carry over, and the counting wrapper hands out a new underlying stream.
      const prepared =
        stall !== undefined
          ? this.withStall(init, stall.stallMs, stall.capMs, stall.onProgress)
          : { init: this.withDeadline(init, timeoutMs), dispose: () => {} };
      try {
        res = await this.fetchImpl(url, prepared.init);
      } catch (e) {
        // Network-level failure OR the per-attempt deadline: retry if budget
        // remains. Label a deadline abort explicitly, so an exhausted budget
        // reports "timed out", not an opaque AbortError.
        lastErr = this.labelTimeout(e, label, timeoutMs);
      } finally {
        // The stall path has no `consume`, so the attempt is settled here and
        // the timer must go: an armed one holds a handle until it fires.
        prepared.dispose();
      }
      if (res !== undefined) {
        if (res.ok) {
          if (consume === undefined) return res as unknown as T;
          // Consume the body INSIDE the retry loop: the per-attempt signal
          // also governs the body read, so a server that sends headers and
          // then wedges mid-body aborts here and must count as a retryable
          // attempt failure, not escape unlabeled to the caller.
          try {
            return await consume(res);
          } catch (e) {
            lastErr = this.labelTimeout(e, label, timeoutMs);
            if (attempt < this.retry.attempts) await this.backoff(attempt, null);
            continue;
          }
        }
        // Not returned to the caller: drain the body so undici frees the
        // connection instead of pinning the keep-alive pool until GC.
        void res.body?.cancel();
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
    const { url } = await this.authedFetch(
      `${this.baseUrl}/api/cache/upload-url`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ narUrl, fileHash }),
      },
      "upload-url",
      (res) => res.json() as Promise<{ url: string }>,
    );
    return url;
  }

  /** Upload a NAR directly to R2 via the presigned URL. Callers pass a file-backed
   * Blob (see openAsBlob) so the compressed NAR streams from disk rather than being
   * buffered in memory; the Blob is re-readable, so the retry path still works.
   * `sha256Base64` must equal the value the presigned URL was signed with (see
   * {@link uploadUrl}); R2 rejects the PUT if the sent bytes disagree. */
  async putNar(
    presignedUrl: string,
    body: BodyInit,
    sha256Base64: string,
    onProgress?: UploadProgress,
  ): Promise<void> {
    const res = await this.fetchWithRetry(
      presignedUrl,
      { method: "PUT", body, headers: { "x-amz-checksum-sha256": sha256Base64 } },
      "nar upload",
      this.retry.requestTimeoutMs,
      undefined,
      // Bounded by inactivity, not by a duration guessed from the payload.
      { stallMs: this.retry.uploadStallMs, capMs: this.retry.uploadTimeoutMs, ...(onProgress !== undefined ? { onProgress } : {}) },
    );
    // The PUT response body is unused; drain it so the connection is released.
    void res.body?.cancel();
  }

  /**
   * Mint a presigned PUT and upload the NAR, re-minting ONCE if the URL's validity
   * window lapsed before the upload finished. A multi-GB NAR can outrun the presign
   * TTL, after which R2 403s the expired URL; a fresh URL lets the retry succeed. A
   * 403 that is NOT an expiry (auth, checksum mismatch, object error, judged from
   * the URL's own window) is surfaced, not retried, so real failures are never
   * masked. The NAR streams from disk as a fresh file-backed Blob per attempt.
   */
  async uploadNar(
    narUrl: string,
    fileHash: string,
    file: string,
    sha256Base64: string,
    onProgress?: UploadProgress,
  ): Promise<void> {
    const url = await this.uploadUrl(narUrl, fileHash);
    // No payload-scaled deadline here any more: putNar bounds the attempt by
    // inactivity, which is what a stalled upload actually looks like. Scaling a
    // wall-clock allowance by size gave a 5 GB NAR an 85 minute attempt, so one
    // wedged connection consumed a 90 minute CI job and never reached a retry.
    const blob = await openAsBlob(file);
    try {
      await this.putNar(url, blob, sha256Base64, onProgress);
      return;
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 403 || !presignLapsed(url, Date.now())) throw e;
    }
    const fresh = await this.uploadUrl(narUrl, fileHash);
    await this.putNar(fresh, await openAsBlob(file), sha256Base64, onProgress);
  }

  /** Submit an attestation; returns the promotion decision. */
  async attest(body: AttestBody): Promise<AttestResult> {
    return await this.authedFetch(
      `${this.baseUrl}/api/cache/attest`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      "attest",
      (res) => res.json() as Promise<AttestResult>,
    );
  }

  /**
   * Report that this dispatched reproduction failed.
   *
   * A reproduction that succeeds says so by attesting. One that fails used to
   * say nothing at all, so the control plane could not tell a candidate that
   * cannot be built from one nobody has tried yet, and kept dispatching it on a
   * cooldown for ever. `unresolvable` is for provenance that cannot name the
   * output, which no amount of retrying fixes.
   *
   * Best-effort by design: the job has already failed, and failing to report the
   * failure must not change that outcome or mask the original error.
   */
  async reportReproFailure(hash: string, reason: ReproFailure): Promise<boolean> {
    try {
      await this.authedFetch(
        `${this.baseUrl}/api/repro/dispatch-failed`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hash, reason }),
        },
        "report reproduction failure",
        async () => undefined,
      );
      return true;
    } catch {
      return false;
    }
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
    return await this.authedFetch(
      `${this.baseUrl}/api/cache/push`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      "push",
      (res) => res.json() as Promise<PushResult>,
    );
  }
}

/** Why a dispatched reproduction did not produce an attestation. */
export type ReproFailure = "unresolvable" | "build-failed";

/** The push endpoint's response: the owner namespace the NAR landed in. */
export interface PushResult {
  published: boolean;
  tenant: string;
  substituter: string;
}
