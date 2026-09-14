import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { teeStderr } from "../agent/nix.js";

/** A sink that reports itself full until it is drained, the way a real stderr
 * behaves when the other end reads slowly. */
function slowSink() {
  const writes: Buffer[] = [];
  let full = false;
  const listeners: (() => void)[] = [];
  return {
    writes,
    fill() { full = true; },
    drain() { full = false; for (const l of listeners.splice(0)) l(); },
    write(chunk: Buffer) { writes.push(chunk); return !full; },
    once(event: string, fn: () => void) { if (event === "drain") listeners.push(fn); },
  };
}

describe("teeing a build's stderr", () => {
  it("stops reading the build while the sink is full", async () => {
    // Without this the child keeps producing, the writes queue in this
    // process's memory, and the bound on what is retained for diagnosis says
    // nothing about what the tee itself is holding.
    const source = new PassThrough();
    const sink = slowSink();
    const tee = teeStderr(source, sink as never);
    sink.fill();
    source.write(Buffer.from("one\n"));
    await new Promise((r) => setImmediate(r));
    expect(source.isPaused(), "the build was left running into a full sink").toBe(true);
    sink.drain();
    await new Promise((r) => setImmediate(r));
    expect(source.isPaused(), "the build was never resumed").toBe(false);
    source.write(Buffer.from("two\n"));
    await new Promise((r) => setImmediate(r));
    expect(Buffer.concat(sink.writes).toString()).toBe("one\ntwo\n");
    expect(tee.captured()).toBe("one\ntwo\n");
  });

  it("keeps only the tail of a log that never stops", async () => {
    const source = new PassThrough();
    const sink = slowSink();
    const tee = teeStderr(source, sink as never, 32);
    for (let i = 0; i < 50; i++) source.write(Buffer.from(`line ${i}\n`));
    await new Promise((r) => setImmediate(r));
    const kept = tee.captured();
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(32);
    expect(kept.endsWith("line 49\n")).toBe(true);
  });

  it("starts the tail at a line boundary", async () => {
    // Redaction runs over what is captured, and it recognises a credential by
    // its prefix. A cut in the middle of a line would drop that prefix and leave
    // the rest of the secret looking like ordinary text, so the tail begins at
    // the first whole line rather than wherever the byte bound happens to land.
    const source = new PassThrough();
    const sink = slowSink();
    const tee = teeStderr(source, sink as never, 40);
    source.write(Buffer.from("secret " + "A".repeat(30) + "\ntrailing\n"));
    await new Promise((r) => setImmediate(r));
    const kept = tee.captured();
    expect(kept, "a partial line survived the cut").toBe("trailing\n");
  });
});
