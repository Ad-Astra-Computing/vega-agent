// Shared CLI context: where the control plane is, and the stored credential.
//
// The GitHub token from `vega login` is never stored; only the Vega owner
// credential is, alongside the identity the server returned (so `whoami`/`view`
// need no decode or round-trip) and the control-plane URL it was issued against
// (so a staging credential can't silently target prod).

import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fail } from "./ui.js";

export const DEFAULT_CONTROL_PLANE = "https://vega-cache.dev";

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
  return (flag || process.env.VEGA_URL || DEFAULT_CONTROL_PLANE).replace(/\/$/, "");
}

export async function saveCredential(cred: StoredCredential): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(credentialPath(), `${JSON.stringify(cred, null, 2)}\n`, { mode: 0o600 });
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
    if (typeof cred.credential === "string" && typeof cred.url === "string") return cred;
  } catch {
    /* absent or malformed */
  }
  return null;
}
