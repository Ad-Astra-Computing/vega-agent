import type { NarInfo } from "./types.js";

// Any C0 control char (includes \n, \r, \t) or DEL.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** Reject values that would break the line-oriented narinfo format. */
function assertSingleLine(value: string, field: string): void {
  if (CONTROL_CHARS.test(value)) {
    throw new Error(
      `narinfo field ${field} contains a control/newline character; refusing to serialize`,
    );
  }
}

/** A reference must be a single token: whitespace would split it into two. */
function assertToken(value: string, field: string): void {
  assertSingleLine(value, field);
  if (/\s/.test(value)) {
    throw new Error(`narinfo ${field} must not contain whitespace: ${value}`);
  }
}

/**
 * Parse a `.narinfo` document. Unknown keys are ignored (forward-compat);
 * `Sig` may appear multiple times. `References` is whitespace-separated.
 */
export function parseNarInfo(text: string): NarInfo {
  const fields = new Map<string, string>();
  const sigs: string[] = [];
  let references: string[] = [];
  let sawReferences = false;

  for (const line of text.split("\n")) {
    if (line === "") continue;
    const sep = line.indexOf(": ");
    // A key with an empty value renders as `Key:` (no trailing space).
    const [key, value] =
      sep === -1
        ? [line.endsWith(":") ? line.slice(0, -1) : line, ""]
        : [line.slice(0, sep), line.slice(sep + 2)];

    if (key === "Sig") {
      sigs.push(value);
    } else if (key === "References") {
      sawReferences = true;
      references = value.split(/\s+/).filter((r) => r !== "");
    } else {
      fields.set(key, value);
    }
  }

  const req = (k: string): string => {
    const v = fields.get(k);
    if (v === undefined) throw new Error(`narinfo missing required field: ${k}`);
    return v;
  };
  const num = (k: string): number => {
    const v = req(k);
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`narinfo field ${k} is not a non-negative integer: ${v}`);
    }
    return n;
  };

  const info: NarInfo = {
    storePath: req("StorePath"),
    url: req("URL"),
    compression: req("Compression"),
    fileHash: req("FileHash"),
    fileSize: num("FileSize"),
    narHash: req("NarHash"),
    narSize: num("NarSize"),
    references: sawReferences ? references : [],
    sigs,
  };
  const deriver = fields.get("Deriver");
  if (deriver !== undefined && deriver !== "") info.deriver = deriver;
  return info;
}

/**
 * Serialize a {@link NarInfo} to canonical wire form (matches Nix field order
 * and a trailing newline). Validates every field against injection.
 */
export function formatNarInfo(info: NarInfo): string {
  assertSingleLine(info.storePath, "StorePath");
  assertSingleLine(info.url, "URL");
  assertSingleLine(info.compression, "Compression");
  assertSingleLine(info.fileHash, "FileHash");
  assertSingleLine(info.narHash, "NarHash");
  for (const ref of info.references) assertToken(ref, "References");

  const lines = [
    `StorePath: ${info.storePath}`,
    `URL: ${info.url}`,
    `Compression: ${info.compression}`,
    `FileHash: ${info.fileHash}`,
    `FileSize: ${info.fileSize}`,
    `NarHash: ${info.narHash}`,
    `NarSize: ${info.narSize}`,
    `References: ${info.references.join(" ")}`,
  ];
  if (info.deriver !== undefined) {
    assertToken(info.deriver, "Deriver");
    lines.push(`Deriver: ${info.deriver}`);
  }
  for (const sig of info.sigs) {
    assertSingleLine(sig, "Sig");
    lines.push(`Sig: ${sig}`);
  }
  return lines.join("\n") + "\n";
}
