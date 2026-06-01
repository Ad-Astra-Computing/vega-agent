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
}

/** The attest endpoint's response: the full promotion decision plus what was published. */
export interface AttestResult {
  decision: PromotionDecision;
  publishedTenant: boolean;
  publishedShared: boolean;
}

/** Either a fixed bearer (owner credential) or a provider that mints a fresh
 * one per request (OIDC, which must be re-minted so it never expires mid-job). */
export type TokenSource = string | (() => Promise<string>);

/**
 * Client for the vega control plane, used by the build agent. Bearer auth is
 * the GitHub OIDC token (or an owner credential). `fetch` is injected so the
 * protocol is testable without a network.
 */
export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly tokenFn: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, token: TokenSource, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.tokenFn = typeof token === "function" ? token : async () => token;
    this.fetchImpl = fetchImpl;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.tokenFn()}` };
  }

  /** Ask for a presigned PUT URL for a `nar/...` key. */
  async uploadUrl(narUrl: string): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/cache/upload-url`, {
      method: "POST",
      headers: { ...(await this.authHeaders()), "content-type": "application/json" },
      body: JSON.stringify({ narUrl }),
    });
    if (!res.ok) throw new Error(`upload-url failed: ${res.status}`);
    const { url } = (await res.json()) as { url: string };
    return url;
  }

  /** Upload NAR bytes directly to R2 via the presigned URL. */
  async putNar(presignedUrl: string, body: BodyInit): Promise<void> {
    const res = await this.fetchImpl(presignedUrl, { method: "PUT", body });
    if (!res.ok) throw new Error(`nar upload failed: ${res.status}`);
  }

  /** Submit an attestation; returns the promotion decision. */
  async attest(body: AttestBody): Promise<AttestResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/cache/attest`, {
      method: "POST",
      headers: { ...(await this.authHeaders()), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`attest failed: ${res.status}`);
    return (await res.json()) as AttestResult;
  }

  /**
   * Owner local push (`vega push`): publish an uploaded NAR into the owner's
   * own namespace. The bearer here is an owner credential, not an OIDC token.
   * Unlike `attest`, this produces no shared-tier evidence; the server derives
   * the namespace from the verified credential, never from the client.
   */
  async push(body: AttestBody): Promise<PushResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/cache/push`, {
      method: "POST",
      headers: { ...(await this.authHeaders()), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    // Status only: never echo the response body of an authenticated request
    // (a hostile/buggy server could reflect the credential header into it).
    if (!res.ok) throw new Error(`push failed: ${res.status}`);
    return (await res.json()) as PushResult;
  }
}

/** The push endpoint's response: the owner namespace the NAR landed in. */
export interface PushResult {
  published: boolean;
  tenant: string;
  substituter: string;
}
