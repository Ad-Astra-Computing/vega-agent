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
const RESET = "\x1b[0m";

/** True when we can safely paint animations: an interactive TTY, color allowed. */
export const canAnimate = isTTY && !process.env.NO_COLOR && !process.env.CI;

const truecolor = /truecolor|24bit/.test(process.env.COLORTERM || "");
// Brightness ramp (dim -> white) along the Vega blue->white line: a 24-bit value
// when the terminal supports it, else a safe 16-colour SGR code.
const RAMP: { rgb: [number, number, number]; base: string }[] = [
  { rgb: [58, 63, 85], base: "\x1b[2m\x1b[90m" },
  { rgb: [111, 134, 255], base: "\x1b[34m" },
  { rgb: [185, 198, 255], base: "\x1b[36m" },
  { rgb: [255, 255, 255], base: "\x1b[1m\x1b[37m" },
];
const fg = (lvl: number): string => {
  const c = RAMP[lvl]!;
  return truecolor ? `\x1b[38;2;${c.rgb[0]};${c.rgb[1]};${c.rgb[2]}m` : c.base;
};

// The Vega 8-point sparkle as centered block art: a diamond body (row widths
// 1,3,7,11,7,3,1) with diagonal glints that flash in as it brightens.
const FIELD_W = 17;
const DIAMOND = [1, 3, 7, 11, 7, 3, 1];
const GLINTS: [number, number][] = [[0, 4], [0, 12], [2, 1], [2, 15], [6, 1], [6, 15], [8, 4], [8, 12]];

function starLines(level: number): string[] {
  const g = Array.from({ length: 9 }, () => Array<string>(FIELD_W).fill(" "));
  DIAMOND.forEach((w, i) => {
    const start = (FIELD_W - w) >> 1;
    for (let c = start; c < start + w; c++) g[i + 1]![c] = "█";
  });
  for (const [r, c] of level >= 3 ? GLINTS : level >= 2 ? GLINTS.slice(2, 6) : []) {
    g[r]![c] = level >= 3 ? "+" : "·";
  }
  const cols = process.stdout.columns || 80;
  const body = fg(level);
  const glint = fg(Math.max(0, level - 1));
  const pad = " ".repeat(Math.max(0, (cols - FIELD_W) >> 1));
  const lines = g.map((row) => {
    let s = pad;
    for (const ch of row) s += ch === " " ? " " : (ch === "█" ? body : glint) + ch + RESET;
    return s;
  });
  const word = "V E G A";
  lines.push("", " ".repeat(Math.max(0, (cols - word.length) >> 1)) + "\x1b[1m" + fg(2) + word + RESET);
  return lines; // 9 star rows + blank + word = 11
}

/** Animated brand splash for bare `vega`: a centered Vega sparkle that breathes
 * once. Falls back to a static header when piped / NO_COLOR / CI. */
export async function brandIntro(): Promise<void> {
  if (!canAnimate) {
    info(brandHeader());
    return;
  }
  process.stdout.write("\x1b[?25l"); // hide cursor
  const restore = () => process.stdout.write("\x1b[?25h" + RESET);
  const onSig = () => {
    restore();
    process.exit(130);
  };
  process.once("SIGINT", onSig);
  try {
    let first = true;
    for (const level of [0, 1, 2, 3, 2]) {
      const lines = starLines(level);
      process.stdout.write(
        (first ? "" : `\x1b[${lines.length}A`) + lines.map((l) => `\r\x1b[2K${l}`).join("\n") + "\n",
      );
      first = false;
      await sleep(95);
    }
  } finally {
    restore();
    process.removeListener("SIGINT", onSig);
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
