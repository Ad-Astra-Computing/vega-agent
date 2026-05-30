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

/**
 * Client for the vega control plane, used by the build agent. Bearer auth is
 * the GitHub OIDC token. `fetch` is injected so the protocol is testable
 * without a network.
 */
export class ControlPlaneClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  /** Ask for a presigned PUT URL for a `nar/...` key. */
  async uploadUrl(narUrl: string): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/cache/upload-url`, {
      method: "POST",
      headers: { ...this.authHeaders, "content-type": "application/json" },
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
      headers: { ...this.authHeaders, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`attest failed: ${res.status}`);
    return (await res.json()) as AttestResult;
  }
}
