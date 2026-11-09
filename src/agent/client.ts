import { openAsBlob } from "node:fs";
import { createHash } from "node:crypto";
import { envSeconds } from "./env.js";
import type { PromotionDecision } from "../trust/policy.js";
import type { FailureDiagnosis } from "./failure-diagnosis.js";
import { fetchUncompressed, CompressedResponseError } from "../http/no-compression.js";

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
    /** The parsed JSON body of the refusal, when it had one. Kept off the
     * message on purpose: an authenticated response body is never echoed. */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** The non-2xx `res` as an {@link HttpError}, keeping a JSON body as `detail`
 * (the multipart routes say why they refused there) and releasing the rest. */
async function httpError(res: Response, label: string): Promise<HttpError> {
  let detail: Record<string, unknown> | undefined;
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const body: unknown = await res.json();
      if (typeof body === "object" && body !== null) detail = body as Record<string, unknown>;
    } catch {
      // Not the JSON it claimed to be: the status alone still says enough.
    }
  } else {
    void res.body?.cancel();
  }
  return new HttpError(res.status, `${label} failed: ${res.status}`, detail);
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
   *
   * Read from VEGA_UPLOAD_CAP_SECONDS, deliberately NOT the old
   * VEGA_UPLOAD_TIMEOUT_SECONDS. That name used to mean a FLOOR the payload-scaled
   * allowance was raised from; reusing it would turn an existing `1800` into a hard
   * 30 minute kill that no large upload could ever survive. Under the new name an
   * old setting is simply inert, which is the safe direction.
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
  uploadTimeoutMs: envSeconds("VEGA_UPLOAD_CAP_SECONDS", 0) * 1000,
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

/**
 * NARs this large or larger are uploaded in parts (see
 * {@link ControlPlaneClient.uploadNarInParts}) rather than as one PUT.
 *
 * A single PUT that dies restarts from zero, and a multipart upload pays a few
 * control-plane round trips per part, so the threshold is where losing the whole
 * upload starts to cost noticeably more than those round trips. At 64 MiB a
 * restart costs about a minute on a 1 MB/s link; above it the loss grows with
 * every byte, and past R2's 4.995 GiB single-PUT ceiling a single PUT cannot
 * succeed at all. The part size itself is the control plane's decision, since R2
 * requires every part but the last to be the same size.
 */
export const MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;

/** Whether a NAR of `size` bytes goes up in parts. */
export function usesMultipart(size: number): boolean {
  return size >= MULTIPART_THRESHOLD_BYTES;
}

/**
 * Byte ranges `[start, end)` of each part, in part-number order (part 1 first).
 * Every part is `partSize` long except the last, which takes the remainder.
 */
export function partRanges(size: number, partSize: number): { start: number; end: number }[] {
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(partSize) || partSize < 1) {
    throw new Error(`cannot split ${size} bytes into parts of ${partSize}`);
  }
  const out: { start: number; end: number }[] = [];
  for (let start = 0; start < size; start += partSize) out.push({ start, end: Math.min(start + partSize, size) });
  return out;
}

/**
 * Per-attempt deadline for completing a multipart upload. Completion is the one
 * control-plane call whose work scales with the NAR: the control plane reads the
 * assembled object back and hashes it before answering, which for a multi-GB NAR
 * is minutes, not the seconds every other request gets. Repeating it is safe
 * (the control plane recognises an object it already assembled), so a deadline
 * that fires only costs the work done so far.
 */
const COMPLETE_TIMEOUT_MS = 15 * 60 * 1000;

/** Fresh sessions one upload may start after its session ends under it
 * (it expired, was aborted or another process's completion did not take). A
 * session that keeps ending is a fault to report, not to loop on. */
const MAX_SESSION_RESTARTS = 3;

/** How often to ask whether a completion in flight has settled. The completion
 * hashes the whole NAR, so it takes seconds to minutes. */
const STATUS_POLL_MS = 5_000;

/** Added to the lease time the control plane reports before acting on it. The
 * figure is relative to the server's clock, so this only covers the request's
 * own travel time; being late here costs a few seconds, being early a
 * conflict. */
const TAKEOVER_MARGIN_MS = 2_000;

/** Completions of one session this process will take over before reporting
 * that the session cannot be completed. Each one means a holder died
 * mid-verification; repeated deaths are a fault on the control plane side
 * (a CPU limit, say) that more attempts will not fix. */
const MAX_TAKEOVERS = 2;

/** The control plane's view of a multipart upload session. */
interface MultipartSession {
  status: "open" | "completing" | "exists";
  sessionId: string;
  /** The size the session was opened for, which must be this file's. */
  fileSize: number;
  partSize: number;
  partCount: number;
  /** Parts the control plane has recorded as uploaded. This, not anything kept
   * locally, is what a resumed upload skips. */
  confirmedParts: number[];
}

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly tokenFn: (force?: boolean) => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryOptions;

  constructor(
    baseUrl: string,
    token: TokenSource,
    fetchImpl: typeof fetch = fetchUncompressed,
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
    timeoutMs = this.retry.requestTimeoutMs,
    attempts = this.retry.attempts,
  ): Promise<T> {
    const withAuth = async (force: boolean): Promise<RequestInit> => ({
      ...init,
      headers: { ...init.headers, ...(await this.authHeaders(force)) },
    });
    try {
      return await this.fetchWithRetry(url, await withAuth(false), label, timeoutMs, consume, undefined, attempts);
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        // Recover with a fresh token, but as a SINGLE attempt: re-entering the
        // full retry loop here could run a second whole retry budget on transient
        // failures. The 401 path is a one-shot re-auth, not another retry budget.
        return await this.fetchOnce(url, await withAuth(true), label, consume, timeoutMs);
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
    timeoutMs = this.retry.requestTimeoutMs,
  ): Promise<T> {
    try {
      const res = await this.fetchImpl(url, this.withDeadline(init, timeoutMs));
      if (!res.ok) throw await httpError(res, label);
      return consume === undefined ? (res as unknown as T) : await consume(res);
    } catch (e) {
      throw this.labelTimeout(e, label, timeoutMs);
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
    attempts = this.retry.attempts,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
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
        // A compressed response is a deliberate refusal (CVE-2026-111497),
        // not a network condition a retry could fix: rethrow immediately
        // rather than spending the whole backoff budget on a hostile or
        // misconfigured endpoint that will answer the same way every time.
        if (e instanceof CompressedResponseError) throw e;
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
            if (e instanceof CompressedResponseError) throw e;
            lastErr = this.labelTimeout(e, label, timeoutMs);
            if (attempt < attempts) await this.backoff(attempt, null);
            continue;
          }
        }
        // Not returned to the caller: drain the body so undici frees the
        // connection instead of pinning the keep-alive pool until GC.
        if (!RETRYABLE_STATUS.has(res.status)) throw await httpError(res, label);
        void res.body?.cancel();
        lastErr = new Error(`${label} failed: ${res.status}`);
        if (attempt < attempts) await this.backoff(attempt, res.headers.get("retry-after"));
      } else if (attempt < attempts) {
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
    await this.put(presignedUrl, body, { "x-amz-checksum-sha256": sha256Base64 }, "nar upload", onProgress);
  }

  /** The PUT behind {@link putNar} and each multipart part, returning R2's ETag
   * for the object or part (null if the response carried none). `headers` are
   * the integrity headers the URL was signed for. */
  private async put(
    presignedUrl: string,
    body: BodyInit,
    headers: Record<string, string>,
    label: string,
    onProgress?: UploadProgress,
  ): Promise<string | null> {
    const res = await this.fetchWithRetry(
      presignedUrl,
      { method: "PUT", body, headers },
      label,
      this.retry.requestTimeoutMs,
      undefined,
      // Bounded by inactivity, not by a duration guessed from the payload.
      { stallMs: this.retry.uploadStallMs, capMs: this.retry.uploadTimeoutMs, ...(onProgress !== undefined ? { onProgress } : {}) },
    );
    // The PUT response body is unused; drain it so the connection is released.
    void res.body?.cancel();
    return res.headers.get("etag");
  }

  /**
   * Mint a presigned URL and PUT to it, re-minting ONCE if the URL's validity
   * window lapsed before the upload finished. A 403 that is NOT an expiry (auth,
   * checksum mismatch, object error, judged from the URL's own window) is
   * surfaced, not retried, so real failures are never masked. `body` is called
   * per attempt so a file-backed Blob is opened fresh each time.
   */
  private async putMinted(
    mint: () => Promise<string>,
    body: () => Promise<Blob>,
    headers: Record<string, string>,
    label: string,
    onProgress?: UploadProgress,
  ): Promise<string | null> {
    const url = await mint();
    try {
      return await this.put(url, await body(), headers, label, onProgress);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 403 || !presignLapsed(url, Date.now())) throw e;
    }
    return await this.put(await mint(), await body(), headers, label, onProgress);
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
    const size = (await openAsBlob(file)).size;
    if (usesMultipart(size)) {
      try {
        await this.uploadNarInParts(narUrl, fileHash, file, size, onProgress);
        return;
      } catch (e) {
        // A control plane without the multipart routes answers 404 to the very
        // first call. Anything else is a real failure of the multipart path.
        if (!(e instanceof MultipartUnsupported)) throw e;
      }
    }
    // No payload-scaled deadline here any more: putNar bounds the attempt by
    // inactivity, which is what a stalled upload actually looks like. Scaling a
    // wall-clock allowance by size gave a 5 GB NAR an 85 minute attempt, so one
    // wedged connection consumed a 90 minute CI job and never reached a retry.
    await this.putMinted(
      () => this.uploadUrl(narUrl, fileHash),
      () => openAsBlob(file),
      { "x-amz-checksum-sha256": sha256Base64 },
      "nar upload",
      onProgress,
    );
  }

  /**
   * Upload a NAR in parts, resuming whatever the control plane already holds.
   *
   * The session is found again, not remembered: opening one for a key this
   * principal already has a live session for returns that session and the parts
   * it has recorded. The key content-addresses the NAR, so a process that died
   * and was re-run (a re-run CI job, a restarted worker) rebuilds the same NAR,
   * asks for the same key and skips the parts that already arrived, with nothing
   * persisted on the runner, whose disk a re-run usually does not keep anyway.
   *
   * Each part is its own PUT through the same retry, stall-detection and
   * presign-expiry handling as a single-PUT NAR, so a stalled connection costs
   * the part in flight rather than the whole upload. Parts go one at a time: the
   * agent already uploads several NARs at once, and parts in parallel would
   * multiply the memory and connections each of those holds.
   *
   * A session can end under this process without the NAR failing: it expired,
   * was aborted, or another process holding the same identity (a retried job
   * overlapping the one it replaced) is completing it. Those restart the attempt
   * from a fresh `create`, which resumes, opens a new session or reports the NAR
   * already there, up to {@link MAX_SESSION_RESTARTS} times. A completion by
   * another process is waited for rather than raced (see {@link awaitOther}).
   * Only a refusal that a restart cannot change fails the upload: R2 or the
   * control plane rejecting the bytes themselves.
   */
  async uploadNarInParts(
    narUrl: string,
    fileHash: string,
    file: string,
    size: number,
    onProgress?: UploadProgress,
  ): Promise<void> {
    for (let restarts = 0; ; restarts++) {
      const outcome = await this.multipartAttempt(narUrl, fileHash, file, size, onProgress);
      if (outcome === "done") return;
      if (restarts >= MAX_SESSION_RESTARTS) {
        throw new Error(`multipart upload of ${narUrl}: session ended ${restarts + 1} times without completing`);
      }
    }
  }

  /** One pass over one session: "done" when the NAR is uploaded and verified,
   * "restart" when the session ended in a way a fresh `create` recovers from. */
  private async multipartAttempt(
    narUrl: string,
    fileHash: string,
    file: string,
    size: number,
    onProgress?: UploadProgress,
  ): Promise<"done" | "restart"> {
    let session: MultipartSession;
    try {
      session = await this.multipartCreate(narUrl, fileHash, size);
    } catch (e) {
      // A live session for this key declares another size. The key fixes the
      // bytes, so that session can never complete; abort it and start clean.
      const stale = e instanceof HttpError && e.status === 409 ? e.detail?.sessionId : undefined;
      if (typeof stale !== "string") throw e;
      await this.multipartAbort(stale);
      return "restart";
    }
    if (session.status === "exists") return "done"; // already uploaded and verified
    if (session.status === "completing") return await this.awaitOther(session.sessionId);

    const ranges = partRanges(size, session.partSize);
    if (session.fileSize !== size || ranges.length !== session.partCount) {
      // Created by a client that declared another size; same reasoning as above.
      await this.multipartAbort(session.sessionId);
      return "restart";
    }
    const confirmed = new Set(session.confirmedParts);
    let base = 0;
    for (const [i, { start, end }] of ranges.entries()) {
      const partNumber = i + 1;
      if (!confirmed.has(partNumber)) {
        const part = async (): Promise<Blob> => (await openAsBlob(file)).slice(start, end);
        const md5 = await md5Base64Of(await part());
        let sent: "ok" | "done" | "restart";
        try {
          sent = await this.sessionStep(session.sessionId, async () => {
            const etag = await this.putMinted(
              async () => {
                const minted = await this.multipartPartUrl(session.sessionId, partNumber, md5);
                // The URL is signed for the session's idea of this part's length. If
                // it disagrees with the file, R2 refuses every attempt, so stop here
                // rather than spend a retry budget on a part that cannot land.
                if (minted.size !== end - start) throw new PartLengthMismatch();
                return minted.url;
              },
              part,
              { "content-md5": md5 },
              `nar upload part ${partNumber}/${ranges.length}`,
              onProgress === undefined ? undefined : (moved) => onProgress(base + moved, size),
            );
            if (etag === null) throw new Error(`nar upload part ${partNumber}: R2 returned no ETag`);
            await this.multipartReport(session.sessionId, partNumber, etag);
          });
        } catch (e) {
          if (!(e instanceof PartLengthMismatch)) throw e;
          await this.multipartAbort(session.sessionId);
          return "restart";
        }
        if (sent !== "ok") return sent;
      }
      base += end - start;
      onProgress?.(base, size);
    }
    const completed = await this.completeOnce(session.sessionId);
    if (completed === "done" || completed === "restart") return completed;
    return await this.awaitOther(session.sessionId);
  }

  /**
   * One completion request, deliberately NOT through the generic retry loop.
   *
   * Every other request is safe to resend blindly. A completion is not: the
   * control plane may still be assembling and hashing when this side's deadline
   * fires or the connection drops, and a resend that arrived after the
   * verification lease lapsed would take a fresh lease and hash the whole object
   * a second time alongside the first. So any outcome that does not say what
   * happened (a deadline, a dropped connection or a 5xx) is "unknown". The caller
   * then asks the session's status instead of asking again.
   */
  private async completeOnce(sessionId: string): Promise<"done" | "restart" | "busy" | "unknown"> {
    try {
      await this.multipartCall("complete", { sessionId }, "multipart complete", COMPLETE_TIMEOUT_MS, 1);
      return "done";
    } catch (e) {
      if (e instanceof CompressedResponseError) throw e;
      if (!(e instanceof HttpError)) return "unknown"; // a deadline or a dropped connection
      if (e.status === 409 && e.detail?.state === "completing") return "busy";
      if (e.status === 404 || e.status === 410) return "restart";
      if (e.status === 409) return "restart"; // parts missing, or the session ended
      throw e; // 422: the bytes are not the NAR, which no new session changes
    }
  }

  /**
   * Run one session step, turning the refusals that mean "this session is no
   * longer ours to drive" into an outcome instead of a failure:
   *
   * - 409 with a `state`: another process moved it on (completing, or already
   *   finished). Wait for that to resolve.
   * - 409 with `missing`: completion found parts unrecorded. A restart resumes
   *   and sends exactly those.
   * - 404 or 410: the session expired or was pruned. A restart opens a new one.
   *
   * Everything else, including a 422 for bytes that do not match the file hash,
   * propagates: no new session would make those bytes different.
   */
  private async sessionStep(
    sessionId: string,
    step: () => Promise<void>,
  ): Promise<"ok" | "done" | "restart"> {
    try {
      await step();
      return "ok";
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      if (e.status === 404 || e.status === 410) return "restart";
      if (e.status === 409 && Array.isArray(e.detail?.missing)) return "restart";
      if (e.status === 409 && typeof e.detail?.state === "string") return await this.awaitOther(sessionId);
      throw e;
    }
  }

  /**
   * Wait for a completion in flight to settle, and take it over if it died.
   *
   * Two processes with one identity can hold one session (a retried job
   * overlapping the attempt it replaced), and this process's own completion can
   * outlive its request (the deadline fired, the connection dropped). Either way
   * a completion this process cannot see may be running. This polls the
   * session's status; while it is `completing` the control plane says how long
   * the current verification lease has left, measured on its own clock so this
   * side's clock does not matter. Once that reaches zero the holder is presumed
   * dead and this process completes the session itself, becoming the new
   * holder; a conflict there means another process got in first, and polling
   * resumes. A lease that never settles after {@link MAX_TAKEOVERS} takeovers
   * is reported rather than chased.
   *
   * A lease that let only one process upload at all would prevent the overlap
   * rather than resolve it, but it would also strand an upload behind a holder
   * that died, which is the very case resumption exists for; overlap is rare
   * here (one agent per job), so resolving it is the simpler correct answer.
   */
  private async awaitOther(sessionId: string): Promise<"done" | "restart"> {
    let takeovers = 0;
    for (;;) {
      let st: { status: string; retryAfterMs?: number };
      try {
        st = await this.multipartCall<{ status: string; retryAfterMs?: number }>(
          "status",
          { sessionId },
          "multipart status",
        );
      } catch (e) {
        if (e instanceof HttpError && (e.status === 404 || e.status === 410)) return "restart";
        throw e;
      }
      if (st.status === "completed") return "done";
      // Back to open (its completion was refused and reopened it), or ended:
      // either way a fresh create picks up from whatever the server now holds.
      if (st.status !== "completing") return "restart";
      const left = typeof st.retryAfterMs === "number" && st.retryAfterMs >= 0 ? st.retryAfterMs : STATUS_POLL_MS;
      if (left > 0) {
        await this.retry.sleep(Math.min(left + TAKEOVER_MARGIN_MS, STATUS_POLL_MS));
        continue;
      }
      if (takeovers >= MAX_TAKEOVERS) {
        throw new Error(`multipart upload: the completion of ${sessionId} keeps dying; gave up after ${takeovers} takeovers`);
      }
      takeovers++;
      const r = await this.completeOnce(sessionId);
      if (r === "done" || r === "restart") return r;
      // busy (another process took over first) or unknown: look again.
    }
  }

  private async multipartCall<T>(
    path: string,
    body: unknown,
    label: string,
    timeoutMs?: number,
    attempts?: number,
  ): Promise<T> {
    return await this.authedFetch(
      `${this.baseUrl}/api/cache/multipart/${path}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      label,
      (res) => res.json() as Promise<T>,
      timeoutMs,
      attempts,
    );
  }

  private async multipartCreate(narUrl: string, fileHash: string, fileSize: number): Promise<MultipartSession> {
    try {
      return await this.multipartCall<MultipartSession>("create", { narUrl, fileHash, fileSize }, "multipart create");
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw new MultipartUnsupported();
      throw e;
    }
  }

  private async multipartPartUrl(sessionId: string, partNumber: number, md5: string): Promise<{ url: string; size: number }> {
    return await this.multipartCall<{ url: string; size: number }>(
      "part-url",
      { sessionId, partNumber, md5 },
      `multipart part-url ${partNumber}`,
    );
  }

  private async multipartReport(sessionId: string, partNumber: number, etag: string): Promise<void> {
    await this.multipartCall("part", { sessionId, partNumber, etag }, `multipart report ${partNumber}`);
  }

  /** Abort a session this process will not finish. Already ended (409) or gone
   * (404) is the outcome wanted, so those are not errors. */
  private async multipartAbort(sessionId: string): Promise<void> {
    try {
      await this.multipartCall("abort", { sessionId }, "multipart abort");
    } catch (e) {
      if (!(e instanceof HttpError) || (e.status !== 404 && e.status !== 409)) throw e;
    }
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
   *
   * `attempt` is the dispatch identifier the control plane issued, echoed back
   * so the report is applied only to the dispatch it answers.
   *
   * `diagnosis` is the agent's own classification of the failed build's
   * output (see `failure-diagnosis.ts`); every field on it is optional, and a
   * control plane that does not understand them still gets `hash` and
   * `reason` exactly as before.
   */
  async reportReproFailure(
    hash: string,
    reason: ReproFailure,
    diagnosis?: FailureDiagnosis,
    attempt?: string,
  ): Promise<boolean> {
    try {
      const body: { hash: string; reason: ReproFailure; attempt?: string } & Partial<FailureDiagnosis> = {
        hash,
        reason,
      };
      // An empty value means this job was not dispatched with one, which is
      // what a hand-run reproduction looks like. Sending it would be an id
      // matching no dispatch, and a good report would be dropped for it.
      if (attempt !== undefined && attempt !== "") body.attempt = attempt;
      if (diagnosis?.drv !== undefined) body.drv = diagnosis.drv;
      if (diagnosis?.diagnosis !== undefined) body.diagnosis = diagnosis.diagnosis;
      if (diagnosis?.excerpt !== undefined) body.excerpt = diagnosis.excerpt;
      await this.authedFetch(
        `${this.baseUrl}/api/repro/dispatch-failed`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
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

/** The control plane has no multipart routes, so the NAR goes up as one PUT. */
class MultipartUnsupported extends Error {}

/** The session's length for a part disagrees with the file, so R2 will refuse
 * every upload of it (the length is signed into the URL). */
class PartLengthMismatch extends Error {}

/**
 * Standard base64 MD5 of a Blob, streamed rather than buffered: the
 * `Content-MD5` R2 checks a part against. R2's UploadPart takes no SHA-256, and
 * MD5 here only catches damage in transit; the NAR's integrity is the control
 * plane's SHA-256 of the assembled object at completion.
 */
async function md5Base64Of(blob: Blob): Promise<string> {
  const h = createHash("md5");
  for await (const chunk of blob.stream()) h.update(chunk);
  return h.digest("base64");
}

/** Why a dispatched reproduction did not produce an attestation. */
export type ReproFailure = "unresolvable" | "build-failed";

/** The push endpoint's response: the owner namespace the NAR landed in. */
export interface PushResult {
  published: boolean;
  tenant: string;
  substituter: string;
}
