/**
 * The dependency-closure core shared by `vega gate` (a supply-chain closure-delta
 * gate) and any other closure tooling. Pure: it takes already-parsed
 * `nix path-info --json` output and store-path data, never shells out, so the
 * parsing, diffing, and baseline format are all unit-testable. The CLI does the
 * `nix path-info` exec and policy; this module is the data layer.
 */
import { storePathHash, storePathName } from "./store-path.js";
import type { StorePath } from "./types.js";

/** One store path in a closure, normalized from `nix path-info --json`. */
export interface ClosurePath {
  /** Full store path, e.g. `/nix/store/<hash>-hello-2.12.1`. */
  path: string;
  /** The 32-char store-path hash. */
  hash: string;
  /** The name component (`hello-2.12.1`). */
  name: string;
  /** NAR size in bytes (0 if `nix` did not report it). */
  narSize: number;
  /** Direct references (full store paths), as `nix` reported them. */
  references: string[];
}

interface RawEntry {
  path?: string;
  narSize?: number;
  references?: string[];
}

/**
 * Parse `nix path-info --json` output (either the array form or the path-keyed
 * object form) into a normalized, path-sorted closure. Entries that are not
 * well-formed store paths throw, since a closure must be addressable.
 */
export function parseClosure(json: unknown): ClosurePath[] {
  if (!Array.isArray(json) && (typeof json !== "object" || json === null)) {
    throw new Error("unexpected nix path-info output: not an array or object");
  }
  // A malformed entry must throw, not be dropped: a silently shorter closure
  // would UNDER-report the new paths the gate exists to catch.
  const entries: Array<{ path: string } & RawEntry> = Array.isArray(json)
    ? (json as RawEntry[]).map((e, i) => {
        if (typeof e?.path !== "string") throw new Error(`path-info entry ${i} has no string path`);
        return e as { path: string } & RawEntry;
      })
    : // `path` LAST so the authoritative object key wins over any `path` field
      // inside the value; guard a non-object value so it is not spread.
      Object.entries(json as Record<string, RawEntry>).map(([path, v]) => ({
        ...(typeof v === "object" && v !== null ? v : {}),
        path,
      }));
  return dedupeByPath(
    entries.map((e) => ({
      path: e.path,
      hash: storePathHash(e.path as StorePath),
      name: storePathName(e.path as StorePath),
      narSize: typeof e.narSize === "number" && Number.isFinite(e.narSize) && e.narSize >= 0 ? e.narSize : 0,
      references: Array.isArray(e.references) ? e.references.filter((r) => typeof r === "string") : [],
    })),
  ).sort(byPath);
}

const byPath = (a: ClosurePath, b: ClosurePath): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** A closure is a SET of paths: collapse any duplicate so counts and sizes are
 * not inflated by a repeated entry (e.g. a hand-edited baseline). */
function dedupeByPath(paths: ClosurePath[]): ClosurePath[] {
  const seen = new Set<string>();
  return paths.filter((p) => (seen.has(p.path) ? false : (seen.add(p.path), true)));
}

/** The difference between a baseline closure and a current one. */
export interface ClosureDelta {
  /** Paths in `current` but not `base` (the supply-chain delta). */
  added: ClosurePath[];
  /** Paths in `base` but not `current`. */
  removed: ClosurePath[];
  baseCount: number;
  currentCount: number;
  /** Total NAR bytes of the added/removed paths, and the net change. */
  addedNarSize: number;
  removedNarSize: number;
  netNarSize: number;
}

/** Diff two closures by store path. Pure and order-independent. */
export function diffClosures(base: ClosurePath[], current: ClosurePath[]): ClosureDelta {
  const baseSet = new Set(base.map((p) => p.path));
  const currentSet = new Set(current.map((p) => p.path));
  const added = current.filter((p) => !baseSet.has(p.path)).sort(byPath);
  const removed = base.filter((p) => !currentSet.has(p.path)).sort(byPath);
  const sum = (ps: ClosurePath[]): number => ps.reduce((n, p) => n + p.narSize, 0);
  const addedNarSize = sum(added);
  const removedNarSize = sum(removed);
  return {
    added,
    removed,
    baseCount: base.length,
    currentCount: current.length,
    addedNarSize,
    removedNarSize,
    netNarSize: addedNarSize - removedNarSize,
  };
}

/**
 * A stable, reviewable baseline lockfile: one `"<narSize> <path>"` line per path,
 * sorted by path. Diff-friendly so a PR shows exactly which paths entered or left
 * the closure, and so a reviewer can read it.
 */
export function serializeBaseline(paths: ClosurePath[]): string {
  return [...paths].sort(byPath).map((p) => `${p.narSize} ${p.path}`).join("\n") + "\n";
}

/**
 * Parse a baseline lockfile written by {@link serializeBaseline}. A committed
 * lockfile is trusted input, so a corrupt line (bad spacing, non-numeric or
 * negative size, or a non-store path) THROWS rather than being coerced to a
 * zero-size path that would silently skew the verdict; the caller fails closed.
 */
export function parseBaseline(text: string): ClosurePath[] {
  const paths = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line) => {
      const sp = line.indexOf(" ");
      if (sp < 0) throw new Error(`invalid baseline line (expected "<narSize> <path>"): ${line}`);
      const narSize = Number(line.slice(0, sp));
      if (!Number.isFinite(narSize) || narSize < 0) throw new Error(`invalid narSize in baseline line: ${line}`);
      const path = line.slice(sp + 1);
      return {
        path,
        hash: storePathHash(path as StorePath), // throws on a non-store path
        name: storePathName(path as StorePath),
        narSize,
        references: [],
      };
    });
  return dedupeByPath(paths).sort(byPath);
}
