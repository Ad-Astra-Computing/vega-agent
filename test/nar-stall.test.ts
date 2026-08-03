import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNar } from "../agent/nix.js";

// The NAR pipeline (`nix store dump-path | zstd`) must not hang forever when
// the nix daemon wedges mid-dump: the inactivity watchdog kills the children
// and rejects with a labeled error. Exercised with a fake `nix` on PATH that
// produces no output and never exits.
describe("makeNar stall watchdog", () => {
  let bin: string;
  let work: string;
  const savedPath = process.env.PATH;
  const savedStall = process.env.VEGA_NAR_STALL_SECONDS;

  beforeEach(async () => {
    bin = await mkdtemp(join(tmpdir(), "vega-fake-bin-"));
    work = await mkdtemp(join(tmpdir(), "vega-nar-work-"));
    await writeFile(join(bin, "nix"), "#!/bin/sh\nsleep 60\n");
    await writeFile(join(bin, "zstd"), "#!/bin/sh\ncat\n");
    await chmod(join(bin, "nix"), 0o755);
    await chmod(join(bin, "zstd"), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
    process.env.VEGA_NAR_STALL_SECONDS = "1";
  });

  afterEach(async () => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedStall === undefined) delete process.env.VEGA_NAR_STALL_SECONDS;
    else process.env.VEGA_NAR_STALL_SECONDS = savedStall;
    await rm(bin, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  it("kills a silent dump and rejects instead of hanging", async () => {
    const path = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-stalled";
    await expect(makeNar(path, work)).rejects.toThrow(/produced no data for 1s/);
  }, 15_000);
});
