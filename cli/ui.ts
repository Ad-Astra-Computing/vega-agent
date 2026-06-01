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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True when we can safely paint animations: an interactive TTY, color allowed. */
export const canAnimate = isTTY && !process.env.NO_COLOR && !process.env.CI;

// A short twinkle: the star fades in dim, brightens to white, settles to cyan,
// alternating the filled/outline glyph so it reads as a sparkle, not a spinner.
const TWINKLE: string[] = [
  pc.dim(pc.gray("✧")),
  pc.blue("✦"),
  pc.cyan("✧"),
  pc.bold(pc.white("✦")),
  pc.cyan("✦"),
  pc.dim(pc.cyan("✧")),
  pc.cyan("✦"),
];

/** Animated brand splash for bare `vega`. Falls back to a static header when
 * output is piped, NO_COLOR is set, or we're in CI. */
export async function brandIntro(): Promise<void> {
  const line = (glyph: string): string => `${glyph} ${pc.bold("Vega")}`;
  if (!canAnimate) {
    info(brandHeader());
    return;
  }
  process.stdout.write("\x1b[?25l"); // hide cursor
  try {
    for (const glyph of TWINKLE) {
      process.stdout.write(`\r${line(glyph)}`);
      await sleep(70);
    }
    process.stdout.write(`\r${line(pc.cyan(STAR))}\n`);
  } finally {
    process.stdout.write("\x1b[?25h"); // restore cursor
  }
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
