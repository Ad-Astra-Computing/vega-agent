import { describe, it, expect } from "vitest";
import { encodeNixBase32, decodeNixBase32 } from "../src/nix/nixbase32.js";
import { fingerprint } from "../src/nix/fingerprint.js";
import type { NarInfo } from "../src/nix/types.js";

describe("decodeNixBase32", () => {
  it("round-trips every encoding of a 32-byte digest", () => {
    const digest = new Uint8Array(32);
    for (let i = 0; i < 32; i++) digest[i] = (i * 37 + 11) & 0xff;
    const encoded = encodeNixBase32(digest);
    expect(encoded.length).toBe(52); // sha256 nixbase32 length
    expect(decodeNixBase32(encoded)).toEqual(digest);
  });

  it("rejects a length that is not a valid encoding of any byte count", () => {
    // Valid nixbase32 lengths are encodedLen(n): 0,2,4,5,7,... Lengths 1 and 3
    // encode no whole byte count; without the guard they silently returned a
    // truncated array instead of failing.
    expect(() => decodeNixBase32("z")).toThrow(/length/); // 1
    expect(() => decodeNixBase32("zzz")).toThrow(/length/); // 3
    expect(decodeNixBase32("00").length).toBe(1); // 2 is a valid 1-byte encoding
  });

  it("accepts the empty string as zero bytes", () => {
    expect(decodeNixBase32("")).toEqual(new Uint8Array(0));
  });
});

describe("fingerprint", () => {
  const base: NarInfo = {
    storePath: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-x",
    url: "nar/x.nar.zst",
    compression: "zstd",
    fileHash: "sha256:1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    fileSize: 1,
    narHash: "sha256:0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    narSize: 2,
    references: [],
    sigs: [],
  };

  it("emits references sorted (matching Nix's printStorePathSet), regardless of input order", () => {
    const unsorted = fingerprint({ ...base, references: ["zzz-c", "aaa-a", "mmm-b"] });
    const sorted = fingerprint({ ...base, references: ["aaa-a", "mmm-b", "zzz-c"] });
    expect(unsorted).toBe(sorted);
    expect(unsorted).toContain("/nix/store/aaa-a,/nix/store/mmm-b,/nix/store/zzz-c");
  });

  it("ends in a trailing ';' with zero references", () => {
    expect(fingerprint(base).endsWith(";")).toBe(true);
  });
});
