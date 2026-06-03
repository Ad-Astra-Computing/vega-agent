// Vendored from garnix-ci edge/src/diagnosis (mirrors the canonical classifier,
// same convention as src/nix/*). Keep in sync; do not fork the taxonomy.
/**
 * Taxonomy of build non-determinism causes, from the reproducible-builds.org
 * documentation. Each cause carries signatures — patterns that tend to appear
 * in a `diffoscope` comparison of two divergent builds — and the standard fix.
 *
 * Used two ways: a fast heuristic pre-classifier (see `classify.ts`) that ranks
 * likely causes before any LLM call, and as grounding context handed to the
 * LLM diagnoser so it classifies against a known vocabulary rather than
 * free-associating.
 */

export interface NonDeterminismCause {
  id: string;
  title: string;
  /** Regexes that, when matched in a diff, hint at this cause. */
  signatures: RegExp[];
  /** The canonical remedy. */
  fix: string;
}

export const CAUSES: NonDeterminismCause[] = [
  {
    id: "timestamps",
    title: "Embedded build timestamps",
    signatures: [
      /\b(19|20)\d{2}-\d{2}-\d{2}[ T]\d{2}:\d{2}/,
      /\bmtime\b/i,
      /modification time/i,
      /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b.*\b(19|20)\d{2}\b/,
      /\b(GMT|UTC)\b/,
    ],
    fix: "Honor SOURCE_DATE_EPOCH so embedded timestamps are pinned to the commit time.",
  },
  {
    id: "build-path",
    title: "Embedded build paths",
    signatures: [/\/build\//, /\/tmp\/nix-build-/, /\/nix\/store\/[0-9a-z]{32}-[^/]*\/build/],
    fix: "Strip or remap the build directory (BUILD_PATH_PREFIX_MAP, or patch the build to not embed it).",
  },
  {
    id: "go-buildid",
    title: "Go build ID / toolchain nonce",
    signatures: [/Go build ID/i, /\bbuildid\b/i, /buildinfo/i],
    fix: "Set -trimpath and -buildid= so the Go build ID is stable.",
  },
  {
    id: "date-macros",
    title: "__DATE__ / __TIME__ C macros",
    signatures: [/__DATE__/, /__TIME__/, /__TIMESTAMP__/],
    fix: "Replace __DATE__/__TIME__ with a value derived from SOURCE_DATE_EPOCH.",
  },
  {
    id: "locale",
    title: "Locale-dependent ordering or formatting",
    signatures: [/\bLC_[A-Z]+\b/, /locale/i, /collation/i],
    fix: "Pin LC_ALL=C (or C.UTF-8) during the build for stable sorting and formatting.",
  },
  {
    id: "randomness",
    title: "Unseeded randomness (UUIDs, temp names)",
    signatures: [
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
      /random/i,
    ],
    fix: "Seed or remove the RNG; avoid embedding random identifiers in outputs.",
  },
  {
    id: "archive-metadata",
    title: "Archive metadata (uid/gid, order, timestamps)",
    signatures: [/ar archive/i, /gzip compressed/i, /\buid\b.*\bgid\b/i, /Owner/],
    fix: "Normalize archive metadata: fixed uid/gid 0, sorted entries, pinned mtime, no gzip timestamp.",
  },
  {
    id: "file-ordering",
    title: "Unstable file or symbol ordering",
    signatures: [/order(ing)?/i, /sorted/i],
    fix: "Sort inputs/outputs deterministically (e.g. find | sort) before archiving or linking.",
  },
];

export function causeById(id: string): NonDeterminismCause | undefined {
  return CAUSES.find((c) => c.id === id);
}
