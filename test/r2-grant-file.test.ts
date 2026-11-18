import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// configDir() reads homedir(), which on POSIX reads $HOME, so pointing HOME at
// a scratch directory is how this exercises the real file write without
// touching the developer's own ~/.config/vega.
let home: string;
let realHome: string | undefined;

beforeEach(async () => {
  realHome = process.env.HOME;
  home = await mkdtemp(join(tmpdir(), "vega-r2-grant-test-"));
  process.env.HOME = home;
});

afterEach(async () => {
  process.env.HOME = realHome;
  await rm(home, { recursive: true, force: true });
});

describe("saveR2Grant", () => {
  it("writes the grant to a 0600 file under ~/.config/vega, never world- or group-readable", async () => {
    const { saveR2Grant, r2GrantPath } = await import("../cli/context.js");
    await saveR2Grant({
      bucket: "vega-numinit",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      accessKeyId: "AKIA-id",
      secretAccessKey: "AKIA-secret",
      url: "https://vega-cache.dev",
      revealedAt: 1_700_000_000_000,
    });

    const path = r2GrantPath();
    const contents = JSON.parse(await readFile(path, "utf8")) as { secretAccessKey: string; bucket: string };
    expect(contents.secretAccessKey).toBe("AKIA-secret");
    expect(contents.bucket).toBe("vega-numinit");

    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tightens permissions on an overwrite, not just on first creation", async () => {
    const { saveR2Grant, r2GrantPath } = await import("../cli/context.js");
    const { chmod } = await import("node:fs/promises");
    await saveR2Grant({
      bucket: "vega-numinit",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      accessKeyId: "AKIA-old",
      secretAccessKey: "AKIA-old-secret",
      url: "https://vega-cache.dev",
      revealedAt: 1_700_000_000_000,
    });
    // Simulate a pre-existing file an older agent version left world-readable.
    await chmod(r2GrantPath(), 0o644);

    await saveR2Grant({
      bucket: "vega-numinit",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      accessKeyId: "AKIA-new",
      secretAccessKey: "AKIA-new-secret",
      url: "https://vega-cache.dev",
      revealedAt: 1_700_000_001_000,
    });

    const mode = (await stat(r2GrantPath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
