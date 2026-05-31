// Rendering for the `vega` CLI, kept separate from command logic so the same
// command result can render as a TTY view, plain CI logs, or NDJSON. Nothing
// here decides anything; it only presents. The aesthetic is deliberately
// restrained: one accent (the Vega star), color only where it aids scanning,
// and vocabulary that never overstates ("accepted by your view", not "trusted";
// "reproduced" only when Vega actually reproduced).

import pc from "picocolors";

/** The Vega mark. Used sparingly: bare `vega`, help headers, success moments. */
export const STAR = "✦"; // ✦

export const isTTY = Boolean(process.stdout.isTTY);

/** Provenance labels, never collapsed into a single "trusted" badge. */
export type Provenance = "shared-reproduced" | "social" | "tenant" | "novel" | "unverified";

export function provenanceColor(p: Provenance): string {
  switch (p) {
    case "shared-reproduced":
      return pc.green(p);
    case "social":
      return pc.cyan(p);
    case "tenant":
      return pc.blue(p);
    case "novel":
      return pc.yellow(p);
    case "unverified":
      return pc.gray(p);
  }
}

export function star(text: string): string {
  return `${pc.cyan(STAR)} ${text}`;
}

/** The brand header, for bare `vega` and help. */
export function brandHeader(): string {
  return `${pc.cyan(STAR)} ${pc.bold("Vega")}`;
}

export function success(msg: string): void {
  process.stdout.write(`${pc.green(STAR)} ${msg}\n`);
}

export function info(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`${pc.yellow("warning")}: ${msg}\n`);
}

/** A teaching error: name the failed assumption, then the next command(s). */
export function fail(message: string, next?: string[]): never {
  process.stderr.write(`${pc.red("error")}: ${message}\n`);
  if (next && next.length > 0) {
    process.stderr.write(`\nTry:\n${next.map((n) => `  ${pc.cyan(n)}`).join("\n")}\n`);
  }
  process.exit(1);
}

/** Aligned key: value lines (for whoami/status/view). */
export function keyValues(pairs: [string, string][]): void {
  const width = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) {
    process.stdout.write(`  ${pc.gray(`${k}:`.padEnd(width + 1))} ${v}\n`);
  }
}

/** Emit one NDJSON event line (for `--json`). */
export function jsonEvent(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
