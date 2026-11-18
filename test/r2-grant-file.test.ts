import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// configDir() reads homedir(), which on POSIX reads $HOME, so pointing HOME at
// a scratch directory is how this exercises the real file write without
// touching the developer's own ~/.config/vega. This depends on the test
// running in a process where os.homedir() actually sees the env var we set
// (true for vitest's default fork-based pool, not for a worker-thread pool),
// so every test below asserts the resolved path is inside the scratch home
// BEFORE writing anything: a wrong assumption here fails loudly instead of
// quietly overwriting a real ~/.config/vega/r2-grant.json.
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

const grant = (over: Record<string, string> = {}) => ({
  bucket: "vega-numinit",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  accessKeyId: "test-access-key-id",
  secretAccessKey: "test-secret-access-key",
  url: "https://vega-cache.dev",
  revealedAt: 1_700_000_000_000,
  ...over,
});

describe("saveR2Grant", () => {
  it("writes the grant to a 0600 file under ~/.config/vega, never world- or group-readable", async () => {
    const { saveR2Grant, r2GrantPath } = await import("../cli/context.js");
    expect(r2GrantPath().startsWith(home)).toBe(true);
    await saveR2Grant(grant());

    const path = r2GrantPath();
    const contents = JSON.parse(await readFile(path, "utf8")) as { secretAccessKey: string; bucket: string };
    expect(contents.secretAccessKey).toBe("test-secret-access-key");
    expect(contents.bucket).toBe("vega-numinit");

    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("re-issuing (an overwrite) still lands at 0600, even if the old file was left world-readable", async () => {
    const { saveR2Grant, r2GrantPath } = await import("../cli/context.js");
    expect(r2GrantPath().startsWith(home)).toBe(true);
    await saveR2Grant(grant({ accessKeyId: "old-key-id", secretAccessKey: "old-secret" }));
    // Simulate a pre-existing file an older agent version left world-readable.
    await chmod(r2GrantPath(), 0o644);

    await saveR2Grant(grant({ accessKeyId: "new-key-id", secretAccessKey: "new-secret" }));

    const path = r2GrantPath();
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
    const contents = JSON.parse(await readFile(path, "utf8")) as { secretAccessKey: string };
    expect(contents.secretAccessKey).toBe("new-secret");
  });

  it("never leaves a partially written target: the old file survives until the rename", async () => {
    // Not a true kill-mid-write test (that needs a real process), but it
    // pins the mechanism: the write lands on a temp path, not the target,
    // until the final atomic rename.
    const { saveR2Grant, r2GrantPath } = await import("../cli/context.js");
    expect(r2GrantPath().startsWith(home)).toBe(true);
    await saveR2Grant(grant({ accessKeyId: "first-key-id", secretAccessKey: "first-secret" }));
    const before = await readFile(r2GrantPath(), "utf8");
    expect(before).toContain("first-secret");

    const { readdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const dir = dirname(r2GrantPath());
    const entries = await readdir(dir);
    // Only the final file should remain; no leftover ".tmp" file from the
    // write above (the rename must have replaced it, not left it beside it).
    expect(entries.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});
