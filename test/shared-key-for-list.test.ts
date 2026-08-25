import { describe, it, expect, vi } from "vitest";
import { generateKeyPair, derivePublicKey } from "../src/nix/signing.js";

const pinned = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../cli/keys.js", () => ({
  trustedKeys: async () => [],
  pickTrustedKey: () => pinned.value,
}));

const { sharedKeyForList } = await import("../cli/commands/verify.js");

const shared = derivePublicKey(generateKeyPair("vega-cache-1").secret);
const tenant = derivePublicKey(generateKeyPair("vega-someone-repo-1").secret);

/**
 * Which key may speak for the GLOBAL revocation list. Getting this wrong lets a
 * hostile cache authenticate its own empty list and reach a full green
 * "Verified" on a root the user never chose.
 */
describe("sharedKeyForList", () => {
  it("prefers the pinned key, whatever the flag says", async () => {
    pinned.value = shared;
    expect(await sharedKeyForList(tenant, "vega-cache-1:whatever")).toBe(shared);
  });

  it("accepts a typed flag only when the verifying key IS the shared key", async () => {
    pinned.value = null;
    expect(await sharedKeyForList(shared, "vega-cache-1:abc")).toBe(shared);
    // A flag naming any other key says which key a BUILD should carry; it must
    // never become the authority on a global list.
    expect(await sharedKeyForList(tenant, "vega-someone-repo-1:abc")).toBeNull();
  });

  it("rejects an EMPTY flag, which is not a key the user typed", async () => {
    // `--public-key "$VAR"` with VAR unset. resolveKey ignores an empty flag and
    // on a tenant URL falls back to the key the CACHE publishes; treating that
    // as a typed decision would hand a hostile origin the revocation authority.
    pinned.value = null;
    expect(await sharedKeyForList(shared, "")).toBeNull();
    expect(await sharedKeyForList(shared, undefined)).toBeNull();
  });
});
