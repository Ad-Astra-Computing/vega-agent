/**
 * Progress watchdog for the per-path publish pipeline (compress, upload,
 * attest). The pipeline's workers share chokepoints (the network, the nix
 * daemon, the OIDC token mint), so a single wedged dependency silences all of
 * them at once; observed in production as an upload step that printed nothing
 * for 38 minutes until the job's timeout killed it. Per-request deadlines make
 * such stalls fail and retry; this watchdog additionally names what was
 * in-flight while nothing completed, so the next stall identifies its own
 * culprit stage in the job log instead of needing on-host forensics.
 */
/** Bytes as a human reads them, so a log line is scannable at a glance. */
export function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

interface Inflight {
  stage: string;
  since: number;
  /** Bytes transferred so far, and the total, when the stage reports them. */
  moved?: number;
  total?: number;
  /** Bytes and time at the previous check, to derive a rate over that window. */
  markMoved: number;
  markAt: number;
}

export class StallWatchdog {
  private readonly inflight = new Map<string, Inflight>();
  private lastProgress: number;

  constructor(
    private readonly warnAfterMs: number,
    private readonly now: () => number = Date.now,
    private readonly warn: (msg: string) => void = (m) => console.error(m),
  ) {
    this.lastProgress = this.now();
  }

  /** Record that `path` entered `stage`. */
  stage(path: string, stage: string): void {
    const at = this.now();
    this.inflight.set(path, { stage, since: at, markMoved: 0, markAt: at });
  }

  /**
   * Record transfer progress for `path`. This does NOT count as pipeline
   * progress: a path that is still moving bytes has not completed, and the
   * warning is about completion. It is what makes the warning actionable, since
   * "stalled at 0 B/s" and "slow at 300 KiB/s" call for opposite responses and
   * were previously indistinguishable from the log.
   */
  progress(path: string, movedBytes: number, totalBytes: number): void {
    const e = this.inflight.get(path);
    if (e === undefined) return;
    e.moved = movedBytes;
    e.total = totalBytes;
  }

  /** Record that `path` finished its pipeline (this is what counts as progress). */
  done(path: string): void {
    this.inflight.delete(path);
    this.lastProgress = this.now();
  }

  /** One check: warn (once per check) when work is in flight but nothing has
   * completed within the window. Returns whether a warning was emitted. */
  check(): boolean {
    const now = this.now();
    if (this.inflight.size === 0 || now - this.lastProgress < this.warnAfterMs) return false;
    const stalledS = Math.round((now - this.lastProgress) / 1000);
    const lines = [...this.inflight.entries()].map(([path, e]) => {
      const parts = [`${Math.round((now - e.since) / 1000)}s in stage`];
      if (e.moved !== undefined && e.total !== undefined) {
        const windowS = (now - e.markAt) / 1000;
        // A retry restarts the upload from zero, so `moved` can drop below the
        // previous mark. Report 0 rather than a negative rate, which would be
        // nonsense in the one log line someone reads while diagnosing a stall.
        const delta = Math.max(0, e.moved - e.markMoved);
        const rate = windowS > 0 ? delta / windowS : 0;
        parts.push(`${human(e.moved)}/${human(e.total)}`, `${human(rate)}/s`);
        e.markMoved = e.moved;
        e.markAt = now;
      }
      return `  ${e.stage} ${path} (${parts.join(", ")})`;
    });
    this.warn(`vega-attest: no path has completed for ${stalledS}s; in-flight:\n${lines.join("\n")}`);
    return true;
  }

  /** Check on an interval. The timer is unref'd so it never keeps the process
   * alive; callers still clear it when the pipeline finishes. */
  start(intervalMs: number): NodeJS.Timeout {
    const t = setInterval(() => this.check(), intervalMs);
    t.unref();
    return t;
  }
}
