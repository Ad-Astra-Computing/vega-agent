import { describe, it, expect } from "vitest";
import { StallWatchdog } from "../src/agent/stall-watchdog.js";

/** Watchdog with a controllable clock and captured warnings. */
function makeWatchdog(warnAfterMs: number) {
  let now = 0;
  const warnings: string[] = [];
  const dog = new StallWatchdog(
    warnAfterMs,
    () => now,
    (m) => warnings.push(m),
  );
  return { dog, warnings, tick: (ms: number) => (now += ms) };
}

describe("StallWatchdog", () => {
  it("stays quiet while paths keep completing", () => {
    const { dog, warnings, tick } = makeWatchdog(300_000);
    dog.stage("/nix/store/a", "compress");
    tick(200_000);
    dog.done("/nix/store/a");
    tick(200_000); // 200s since last completion: inside the window
    dog.stage("/nix/store/b", "upload");
    expect(dog.check()).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("names each in-flight path, its stage and its age when nothing completes", () => {
    const { dog, warnings, tick } = makeWatchdog(300_000);
    dog.stage("/nix/store/a", "upload");
    tick(100_000);
    dog.stage("/nix/store/b", "attest");
    tick(250_000); // 350s with no done(): stalled
    expect(dog.check()).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no path has completed for 350s");
    expect(warnings[0]).toContain("upload /nix/store/a (350s in stage)");
    expect(warnings[0]).toContain("attest /nix/store/b (250s in stage)");
  });

  it("reports transfer rate so a stalled upload reads differently from a slow one", () => {
    // The production stall printed only "5293s in stage", which cannot say
    // whether the upload was wedged or merely slow. The two call for opposite
    // responses, so the warning has to distinguish them.
    const { dog, warnings, tick } = makeWatchdog(300_000);
    dog.stage("/nix/store/slow", "upload");
    dog.stage("/nix/store/dead", "upload");
    tick(350_000);
    dog.progress("/nix/store/slow", 350 * 1024 * 1024, 5 * 1024 * 1024 * 1024);
    dog.progress("/nix/store/dead", 0, 5 * 1024 * 1024 * 1024);
    expect(dog.check()).toBe(true);
    expect(warnings[0]).toContain("350 MiB/5.0 GiB");
    expect(warnings[0]).toContain("0 B/s"); // the wedged one, unmistakably
    // A second window with no further bytes shows the slow one flatlining too.
    tick(100_000);
    expect(dog.check()).toBe(true);
    expect(warnings[1]).toContain("350 MiB/5.0 GiB, 0 B/s");
  });

  it("a completion resets the stall window", () => {
    const { dog, tick } = makeWatchdog(300_000);
    dog.stage("/nix/store/a", "upload");
    dog.stage("/nix/store/b", "upload");
    tick(350_000);
    dog.done("/nix/store/a"); // progress: the window restarts here
    tick(100_000);
    expect(dog.check()).toBe(false);
  });

  it("never warns with nothing in flight (the pipeline is simply done)", () => {
    const { dog, tick } = makeWatchdog(300_000);
    dog.stage("/nix/store/a", "attest");
    dog.done("/nix/store/a");
    tick(1_000_000);
    expect(dog.check()).toBe(false);
  });
});
