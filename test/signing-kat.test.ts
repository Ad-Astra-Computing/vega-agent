import { describe, it, expect } from "vitest";
import {
  parseSecretKey,
  parsePublicKey,
  derivePublicKey,
  formatPublicKey,
  signBytes,
  verifyBytes,
} from "../src/nix/signing.js";

/**
 * Known-answer vector for Ed25519 signing.
 *
 * Ed25519 is deterministic (RFC 8032), so a fixed key and message have exactly
 * one correct signature. This pins that byte output through Vega's own signing
 * wrappers, so a future change in the crypto library (a `@noble/curves` bump, a
 * swapped implementation) that silently altered the produced bytes fails here
 * rather than passing the round-trip tests and shipping a signature no existing
 * key or verifier agrees with. The vector was generated once and cross-checked
 * byte-for-byte between @noble/curves 1.x and 2.x; the master key that gates the
 * shared tier depends on this output never moving.
 *
 * The secret key is a throwaway fixed seed, never a real Vega key.
 */
const VECTOR = {
  secret:
    "vega-kat-1:CzBVep/E6Q4zWH2ix+wRNluApcrvFDleg6jN8hc8YYYkw6SU+iKZYmZEuWWpEy2nnP5nFR/cQt5gDPCQl9uCRw==",
  public: "vega-kat-1:JMOklPoimWJmRLllqRMtp5z+ZxUf3ELeYAzwkJfbgkc=",
  message: "vega known-answer vector: do not change",
  signature:
    "vega-kat-1:M8eDAtZQkUDp5JOcBOW1eJ50YeOYvocwQvbbCd2Cj5Rknk0PoCk42v07b5O2nyALI/nyxE7cz4V2q8jc3D0ZCg==",
};

describe("Ed25519 signing known-answer vector", () => {
  const secret = parseSecretKey(VECTOR.secret);
  const message = new TextEncoder().encode(VECTOR.message);

  it("derives the pinned public key from the secret seed", () => {
    expect(formatPublicKey(derivePublicKey(secret))).toBe(VECTOR.public);
  });

  it("produces the exact pinned signature bytes", () => {
    expect(signBytes(secret, message)).toBe(VECTOR.signature);
  });

  it("verifies the pinned signature against the pinned public key", () => {
    expect(verifyBytes(parsePublicKey(VECTOR.public), message, VECTOR.signature)).toBe(true);
  });

  it("rejects the pinned signature over a tampered message", () => {
    const tampered = new TextEncoder().encode(VECTOR.message + " ");
    expect(verifyBytes(parsePublicKey(VECTOR.public), tampered, VECTOR.signature)).toBe(false);
  });
});
