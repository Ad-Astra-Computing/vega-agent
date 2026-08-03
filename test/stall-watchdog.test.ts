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
