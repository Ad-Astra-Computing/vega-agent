// Shared CLI context: where the control plane is, and the stored credential.
//
// The GitHub token from `vega login` is never stored; only the Vega owner
// credential is, alongside the identity the server returned (so `whoami`/`view`
// need no decode or round-trip) and the control-plane URL it was issued against
// (so a staging credential can't silently target prod).

import { readFile, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fail } from "./ui.js";

export const DEFAULT_CONTROL_PLANE = "https://vega-cache.dev";

/**
 * Validate and normalize a control-plane URL. Credentials and the GitHub token
 * are sent here, so it MUST be https (the only exception is an explicit local
 * dev host). Reconstructing from origin+path also drops any query/userinfo.
 */
/** Normalize+validate, or null if invalid/non-https (non-local). Never fails. */
export function parseControlPlane(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !isLocal) return null;
  return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, "");
}

export function assertSafeControlPlane(url: string): string {
  const normalized = parseControlPlane(url);
  if (normalized === null) {
    fail(`control plane must be a valid https URL (got '${url}'); refusing to send credentials over plaintext.`);
  }
  return normalized;
}

/** A bounded, safe error string from a response: status plus a JSON `error`
 * field if present, NEVER the raw body (which a hostile/buggy server could
 * populate with echoed auth headers). */
export async function safeError(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") detail = `: ${body.error.slice(0, 200)}`;
  } catch {
    /* non-JSON body: status alone */
  }
  return `${res.status}${detail}`;
}

export interface StoredCredential {
  credential: string;
  login: string;
  /** Immutable GitHub numeric user id; the owner namespace is `owner:<userId>`. */
  userId: string;
  expiresAt: number;
  /** The control plane this credential was issued against. */
  url: string;
}

export function configDir(): string {
  return join(homedir(), ".config", "vega");
}
export function credentialPath(): string {
  return join(configDir(), "credential");
}

/** Where `vega login` should enroll: explicit flag, else env, else prod. */
export function controlPlaneFor(flag?: string): string {
  return assertSafeControlPlane(flag || process.env.VEGA_URL || DEFAULT_CONTROL_PLANE);
}

export async function saveCredential(cred: StoredCredential): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  const path = credentialPath();
  await writeFile(path, `${JSON.stringify(cred, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode only applies on create; enforce 0600 on overwrite too, so a
  // pre-existing world-readable credential file is tightened on re-login.
  await chmod(path, 0o600);
}

export async function clearCredential(): Promise<boolean> {
  try {
    await rm(credentialPath());
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Load the credential, or fail with a teaching error pointing at `vega login`. */
export async function requireCredential(): Promise<StoredCredential> {
  let raw: string;
  try {
    raw = await readFile(credentialPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      fail("not enrolled: this machine has no Vega credential.", ["vega login"]);
    }
    throw e;
  }
  let cred: StoredCredential;
  try {
    cred = JSON.parse(raw) as StoredCredential;
  } catch {
    fail(`malformed credential at ${credentialPath()}.`, ["vega login"]);
  }
  if (typeof cred.credential !== "string" || typeof cred.url !== "string") {
    fail(`malformed credential at ${credentialPath()}.`, ["vega login"]);
  }
  // The stored host must still be a valid https control plane (guards a stale or
  // tampered credential pointing at a plaintext/garbage URL).
  cred.url = assertSafeControlPlane(cred.url);
  if (cred.expiresAt && cred.expiresAt < Date.now()) {
    fail(`credential expired ${new Date(cred.expiresAt).toISOString().slice(0, 10)}.`, ["vega login"]);
  }
  return cred;
}

/** Bearer auth header for control-plane requests. */
export function authHeaders(cred: StoredCredential): Record<string, string> {
  return { authorization: `Bearer ${cred.credential}`, "content-type": "application/json" };
}

/** Load the credential if present and well-formed, else null. Never fails. */
export async function loadCredentialMaybe(): Promise<StoredCredential | null> {
  try {
    const cred = JSON.parse(await readFile(credentialPath(), "utf8")) as StoredCredential;
    if (typeof cred.credential === "string" && parseControlPlane(cred.url) !== null) return cred;
  } catch {
    /* absent or malformed */
  }
  return null;
}
