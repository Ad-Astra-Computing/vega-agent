/**
 * Nix's non-standard base32 codec. Not RFC4648: the alphabet omits e, o, t, u,
 * there is no padding, and bytes are read in reverse, 5 bits at a time. This is
 * the encoding used for hashes in `.narinfo` (`sha256:<nixbase32>`).
 *
 * Ported from the reference algorithm (nixos/nix src/libutil/hash.cc); pinned by
 * the canonical vectors in test/nixbase32.test.ts.
 */

const ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";

const REVERSE = (() => {
  const r = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) r[ALPHABET.charCodeAt(i)] = i;
  return r;
})();

/** Number of base32 chars needed to represent `nBytes` bytes. */
function encodedLen(nBytes: number): number {
  return nBytes === 0 ? 0 : Math.floor((nBytes * 8 - 1) / 5) + 1;
}

export function encodeNixBase32(bytes: Uint8Array): string {
  const len = encodedLen(bytes.length);
  let s = "";
  for (let n = len - 1; n >= 0; n--) {
    const b = n * 5;
    const i = b >> 3;
    const j = b & 7;
    const c = (bytes[i]! >> j) | (i + 1 < bytes.length ? bytes[i + 1]! << (8 - j) : 0);
    s += ALPHABET[c & 0x1f];
  }
  return s;
}

export function decodeNixBase32(s: string): Uint8Array {
  const bytesLen = Math.floor((s.length * 5) / 8);
  const bytes = new Uint8Array(bytesLen);
  for (let n = 0; n < s.length; n++) {
    const code = s.charCodeAt(s.length - 1 - n);
    const digit = code < 128 ? REVERSE[code]! : -1;
    if (digit < 0) {
      throw new Error(`invalid nixbase32 character: ${JSON.stringify(s[s.length - 1 - n])}`);
    }
    const b = n * 5;
    const i = b >> 3;
    const j = b & 7;
    bytes[i]! |= (digit << j) & 0xff;
    const carry = digit >> (8 - j);
    if (i + 1 < bytesLen) {
      bytes[i + 1]! |= carry;
    } else if (carry !== 0) {
      throw new Error("invalid nixbase32: non-zero carry past end");
    }
  }
  return bytes;
}
