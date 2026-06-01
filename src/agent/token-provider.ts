/**
 * Lazily mints GitHub OIDC JWTs and caches each until it nears expiry, so a long
 * build never leaves a stale token at push time. The runner's request
 * credential is captured in the agent's memory and minted on demand; the agent
 * still strips `ACTIONS_ID_TOKEN_REQUEST_*` from the environment before building
 * (see agent/main.ts), so nothing a build spawns can mint a token.
 */

/** Decode a JWT's `exp` claim (epoch seconds) WITHOUT verifying it. We only use
 * this to decide when to refresh; the control plane does the real verification. */
export function jwtExpSeconds(jwt: string): number | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  let b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
  b64 += "=".repeat((4 - (b64.length % 4)) % 4);
  try {
    const payload = JSON.parse(atob(b64)) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

export interface TokenProvider {
  get(): Promise<string>;
}

export class OidcTokenProvider implements TokenProvider {
  private cached: string | null = null;
  private expSeconds = 0;

  /**
   * @param mint  fetches a fresh JWT (binds the in-memory request credential).
   * @param skewSeconds  refresh this many seconds before the token's `exp`.
   * @param now  injectable clock (ms), for tests.
   */
  constructor(
    private readonly mint: () => Promise<string>,
    private readonly skewSeconds = 60,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<string> {
    const nowS = Math.floor(this.now() / 1000);
    if (this.cached !== null && nowS + this.skewSeconds < this.expSeconds) {
      return this.cached;
    }
    const token = await this.mint();
    this.cached = token;
    // If the token carries no readable exp, assume a short life and refresh soon.
    this.expSeconds = jwtExpSeconds(token) ?? nowS + 240;
    return token;
  }
}
