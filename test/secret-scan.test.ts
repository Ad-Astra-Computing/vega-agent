import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanForSecrets, scanStorePath, redactKnownSecrets } from "../src/agent/secret-scan.js";

describe("scanForSecrets", () => {
  it("flags a PEM private key block", () => {
    const hits = scanForSecrets("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz...\n-----END OPENSSH PRIVATE KEY-----");
    expect(hits.map((h) => h.kind)).toContain("private-key");
  });

  it("flags an AWS access key id", () => {
    expect(scanForSecrets("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE").map((h) => h.kind)).toContain("aws-access-key");
  });

  it("flags GitHub, Slack, Google, and Stripe tokens", () => {
    const kinds = (s: string) => scanForSecrets(s).map((h) => h.kind);
    expect(kinds(`token=ghp_${"a".repeat(36)}`)).toContain("github-token");
    // Assemble the sample token from parts so a contiguous literal never enters
    // git history; GitHub push protection flags a Slack token even in a test.
    const slack = ["xoxb", "2222222222", "3333333333", "aBcDeFgHiJkLmNoPqRsTuVwX"].join("-");
    expect(kinds(slack)).toContain("slack-token");
    expect(kinds(`key=AIza${"a".repeat(35)}`)).toContain("google-api-key");
    expect(kinds(`sk_live_${"0".repeat(24)}`)).toContain("stripe-key");
  });

  it("does NOT flag nix store-path hashes or ordinary content (low false positives)", () => {
    const benign =
      "/nix/store/h1p9v7q2zk3mn4b5c6d7e8f9g0abcdef-hello-2.12.1\n" +
      "sha256:0yp1v1fb4k0f14s2mr1hmvpqgwzxd31679dls9h6ia0g9n2r2r67\n" +
      "the quick brown fox jumps over the lazy dog";
    expect(scanForSecrets(benign)).toEqual([]);
  });

  it("redacts the matched secret in the finding (never returns it verbatim)", () => {
    const hit = scanForSecrets(`ghp_${"b".repeat(36)}`)[0]!;
    expect(hit.kind).toBe("github-token");
    expect(hit.preview).toMatch(/…|\*/); // redacted, not the full token
    expect(hit.preview).not.toContain("b".repeat(36));
  });

  it("reports every distinct match with a 1-based line number", () => {
    const hits = scanForSecrets(`clean line\nAKIAIOSFODNN7EXAMPLE\nclean`);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(2);
  });
});

describe("redactKnownSecrets", () => {
  it("redacts a token embedded in an otherwise-plain string (e.g. a file path)", () => {
    const token = `ghp_${"d".repeat(36)}`;
    const out = redactKnownSecrets(`/nix/store/abc-out/${token}/key`);
    expect(out).not.toContain(token);
    expect(out).toContain("ghp_dd…");
    expect(out.startsWith("/nix/store/abc-out/")).toBe(true);
  });

  it("leaves a path with no known secret unchanged", () => {
    const p = "/nix/store/h1p9v7q2zk3mn4b5c6d7e8f9g0abcdef-hello-2.12.1/bin/hello";
    expect(redactKnownSecrets(p)).toBe(p);
  });
});

describe("scanStorePath", () => {
  it("finds secrets in text files, skips binaries, and does not follow symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "vega-scan-"));
    await mkdir(join(root, "etc"), { recursive: true });
    await writeFile(join(root, "etc/config"), `host=db\ntoken=ghp_${"c".repeat(36)}\n`);
    await writeFile(join(root, "bin-blob"), Buffer.from([0, 1, 2, 0, 65, 75, 73, 65])); // NUL -> binary, skipped
    // a symlink to a dir full of "secrets" must NOT be followed (would be the dep closure)
    const other = await mkdtemp(join(tmpdir(), "vega-dep-"));
    await writeFile(join(other, "leak"), `AKIAIOSFODNN7EXAMPLE`);
    await symlink(other, join(root, "dep"));

    const hits = await scanStorePath(root);
    expect(hits.map((h) => h.kind)).toEqual(["github-token"]); // the dep symlink + binary are excluded
    expect(hits[0]!.file).toContain("etc/config");
  });

  it("scans a regular-FILE output, not only directories", async () => {
    // A writeText/runCommand package writes $out as a file; readdir(root) would
    // throw ENOTDIR and silently scan nothing.
    const dir = await mkdtemp(join(tmpdir(), "vega-scanfile-"));
    const file = join(dir, "out");
    await writeFile(file, `secret\nAKIAIOSFODNN7EXAMPLE\n`);
    const hits = await scanStorePath(file);
    expect(hits.map((h) => h.kind)).toEqual(["aws-access-key"]);
    expect(hits[0]!.file).toBe(file);
  });

  it("caps total findings even when a single file is dense with secrets", async () => {
    // A malicious 2 MiB output packed with tokens must not emit unbounded
    // findings: the per-file append honors the same MAX_FINDINGS (1000) cap.
    const dir = await mkdtemp(join(tmpdir(), "vega-dense-"));
    const file = join(dir, "dense");
    const lines = Array.from({ length: 1500 }, () => "AKIAIOSFODNN7EXAMPLE").join("\n");
    await writeFile(file, lines);
    const hits = await scanStorePath(file);
    expect(hits.length).toBe(1000);
  });

  it("does not follow a symlink ROOT into the closure", async () => {
    const target = await mkdtemp(join(tmpdir(), "vega-target-"));
    await writeFile(join(target, "leak"), "AKIAIOSFODNN7EXAMPLE");
    const linkDir = await mkdtemp(join(tmpdir(), "vega-link-"));
    const link = join(linkDir, "out");
    await symlink(target, link);
    expect(await scanStorePath(link)).toEqual([]); // a symlink root is not followed
  });
});
