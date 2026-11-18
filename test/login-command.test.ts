import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `vega login` was otherwise untested: nothing exercised the actual command
 * action, only pure helpers extracted from other commands. The property that
 * matters most for the direct-R2 grant reveal is specifically an I/O
 * sequencing one ("the secret never reaches stdout on the happy path"), which
 * a pure-function extraction cannot capture, so this drives the real command
 * through Commander with the network mocked.
 */
vi.mock("../src/agent/device-flow.js", () => ({
  VEGA_GITHUB_CLIENT_ID: "test-client-id",
  requestDeviceCode: vi.fn(async () => ({
    deviceCode: "dc",
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresIn: 60,
    interval: 0,
  })),
  pollAccessToken: vi.fn(async () => ({ status: "token" as const, accessToken: "gh-token" })),
}));

const enrollResponse = vi.fn();
const fetchUncompressed = vi.fn(async (..._args: unknown[]) => enrollResponse());
vi.mock("../src/http/no-compression.js", () => ({
  fetchUncompressed: (...args: unknown[]) => fetchUncompressed(...args),
}));

// A real saveR2Grant by default (so the happy-path test writes and can read
// back a real file), overridable per test to exercise the save-failure path
// without touching the filesystem.
vi.mock("../cli/context.js", async () => {
  const actual = await vi.importActual<typeof import("../cli/context.js")>("../cli/context.js");
  return { ...actual, saveR2Grant: vi.fn(actual.saveR2Grant) };
});

let home: string;
let realHome: string | undefined;
let stdout: string[];
let stderr: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  realHome = process.env.HOME;
  home = await mkdtemp(join(tmpdir(), "vega-login-test-"));
  process.env.HOME = home;
  stdout = [];
  stderr = [];
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  // fail() calls process.exit(1) directly, which exitOverride() does not
  // intercept (that only covers commander's own option-parsing errors). An
  // unexpected call here must fail the test, not kill the test runner.
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new Error(`process.exit(${code}) called unexpectedly`);
  }) as (code?: string | number | null) => never);
  enrollResponse.mockReset();
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  exitSpy.mockRestore();
  process.env.HOME = realHome;
  await rm(home, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function runLogin(): Promise<void> {
  const { registerLogin } = await import("../cli/commands/login.js");
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit on a commander-level error
  registerLogin(program);
  await program.parseAsync(["node", "vega", "login", "--url", "https://vega-test.example"]);
}

describe("vega login", () => {
  it("declares the r2-grant capability on every enroll call", async () => {
    enrollResponse.mockResolvedValue({
      ok: true,
      json: async () => ({
        credential: "owner-cred",
        login: "octocat",
        userId: "583231",
        expiresAt: Date.now() + 90 * 86_400_000,
      }),
    });

    await runLogin();

    expect(fetchUncompressed).toHaveBeenCalledTimes(1);
    const [, init] = fetchUncompressed.mock.calls[0]!;
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers["x-vega-capabilities"]).toBe("r2-grant");
  });

  it("never writes the R2 grant's secretAccessKey to stdout or stderr on the happy path", async () => {
    enrollResponse.mockResolvedValue({
      ok: true,
      json: async () => ({
        credential: "owner-cred",
        login: "octocat",
        userId: "583231",
        expiresAt: Date.now() + 90 * 86_400_000,
        r2Grant: {
          bucket: "vega-octocat",
          endpoint: "https://acct.r2.cloudflarestorage.com",
          accessKeyId: "test-access-key-id",
          secretAccessKey: "do-not-print-this-secret",
        },
      }),
    });

    await runLogin();

    const allOutput = [...stdout, ...stderr].join("");
    expect(allOutput).not.toContain("do-not-print-this-secret");

    // And it is announced, so the test cannot pass vacuously because the
    // grant branch silently never ran.
    expect(stdout.join("")).toContain("direct R2 write grant");

    const { r2GrantPath } = await import("../cli/context.js");
    const saved = JSON.parse(await readFile(r2GrantPath(), "utf8")) as { secretAccessKey: string };
    expect(saved.secretAccessKey).toBe("do-not-print-this-secret");
  });

  it("prints nothing R2-grant-related when the enroll response carries none", async () => {
    enrollResponse.mockResolvedValue({
      ok: true,
      json: async () => ({
        credential: "owner-cred",
        login: "octocat",
        userId: "583231",
        expiresAt: Date.now() + 90 * 86_400_000,
      }),
    });

    await runLogin();

    expect(stdout.join("")).not.toContain("direct R2 write grant");
    const { r2GrantPath } = await import("../cli/context.js");
    await expect(readFile(r2GrantPath(), "utf8")).rejects.toThrow();
  });

  it("falls back to printing the secret once on stderr, loudly, only if saving it fails", async () => {
    enrollResponse.mockResolvedValue({
      ok: true,
      json: async () => ({
        credential: "owner-cred",
        login: "octocat",
        userId: "583231",
        expiresAt: Date.now() + 90 * 86_400_000,
        r2Grant: {
          bucket: "vega-octocat",
          endpoint: "https://acct.r2.cloudflarestorage.com",
          accessKeyId: "test-access-key-id",
          secretAccessKey: "fallback-secret",
        },
      }),
    });

    const context = await import("../cli/context.js");
    (context.saveR2Grant as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("disk full"));

    await runLogin();

    // This is the one deliberate exception to "never prints the secret": the
    // control plane has already forgotten it, so losing the save loses it
    // forever unless it goes to the terminal instead.
    expect(stderr.join("")).toContain("fallback-secret");
    expect(stderr.join("")).toMatch(/warning/i);
  });
});
