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
export class StallWatchdog {
  private readonly inflight = new Map<string, { stage: string; since: number }>();
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
    this.inflight.set(path, { stage, since: this.now() });
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
    const lines = [...this.inflight.entries()].map(
      ([path, e]) => `  ${e.stage} ${path} (${Math.round((now - e.since) / 1000)}s in stage)`,
    );
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
