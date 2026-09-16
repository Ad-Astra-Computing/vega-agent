import { describe, it, expect } from "vitest";
import { classifyFailure, buildExcerpt } from "../src/agent/failure-diagnosis.js";

// A valid nix store-path hash: exactly the 32-symbol nixbase32 alphabet
// (digits and lowercase letters minus e, o, t, u), so the drv-matching regex
// (which uses the real alphabet) actually recognizes it.
const HASH = "0123456789abcdfghijklmnpqrsvwxyz";

describe("classifyFailure: recognized diagnoses", () => {
  it("labels a host executable outside /nix/store called from a sandboxed build", () => {
    // The incident the spec exists for: nix-update-notifier calling macOS
    // system tools under sandbox=true. 126 is the builder's own status, which
    // nix reports in the text; nix itself exits 100.
    const output = [
      `building '/nix/store/${HASH}-nix-update-notifier.drv'...`,
      `error: builder for '/nix/store/${HASH}-nix-update-notifier.drv' failed with exit code 126;`,
      "       last 3 log lines:",
      "       > /usr/bin/sips: No such file or directory",
      "       > /usr/libexec/PlistBuddy: Permission denied",
    ].join("\n");
    const r = classifyFailure(output);
    expect(r.diagnosis).toBe("impure-host-path");
    expect(r.drv).toBe(`/nix/store/${HASH}-nix-update-notifier.drv`);
  });

  it("labels a sandbox setup refusal", () => {
    const output =
      "error: while setting up the build environment: mounting '/nix/store' failed\n" +
      "error: 'sandbox-fallback' is disabled, so cannot fall back to building without a sandbox\n";
    expect(classifyFailure(output).diagnosis).toBe("sandbox-denied");
  });

  it("labels a DNS or connection failure inside a build", () => {
    expect(
      classifyFailure("error: unable to download 'https://example.com/x.tar.gz': Couldn't resolve host name")
        .diagnosis,
    ).toBe("network");
    expect(
      classifyFailure("error: cannot fetch input: Temporary failure in name resolution").diagnosis,
    ).toBe("network");
  });

  it("labels running out of disk space", () => {
    expect(classifyFailure("error: writing to file: No space left on device").diagnosis).toBe(
      "out-of-space",
    );
  });

  it("labels a build timeout", () => {
    expect(
      classifyFailure("error: possible deadlock: builder produced no output for 600 seconds, timed out")
        .diagnosis,
    ).toBe("timeout");
  });

  it("labels an evaluation error distinctly from a build error", () => {
    const output = "error: flake 'github:o/r' does not provide attribute 'packages.x86_64-linux.gone'";
    expect(classifyFailure(output).diagnosis).toBe("eval");
    // The same wording inside an actual build failure must not be mislabeled:
    // a build controls its own stderr and can print anything, including this
    // exact phrase, so the "eval" label must come from the absence of a build
    // failure marker, not from a substring match alone.
    const buildFailureEchoingEvalWords =
      `error: builder for '/nix/store/${HASH}-x.drv' failed with exit code 1;\n` +
      "       > does not provide attribute (this is the BUILD's own stdout, not nix's)";
    expect(classifyFailure(buildFailureEchoingEvalWords).diagnosis).not.toBe("eval");
  });

  it("does not call an ordinary build failure impure", () => {
    // Every nix store path contains /bin/, and "No such file or directory" is
    // in half of all compiler output. Matching those anywhere in the log labels
    // a missing header file as an impurity, and a wrong label sends a producer
    // after a problem they do not have.
    const output = [
      `building '/nix/store/${HASH}-hello.drv'...`,
      `/nix/store/${HASH}-gcc-wrapper/bin/gcc -o hello hello.c`,
      "hello.c:1:10: fatal error: stdio.h: No such file or directory",
      `error: builder for '/nix/store/${HASH}-hello.drv' failed with exit code 1`,
    ].join("\n");
    expect(classifyFailure(output).diagnosis).toBe("other");
  });

  it("does not call a build a timeout because its output says the word", () => {
    const output = [
      "running tests",
      "  ok setTimeout fires after the timeout",
      `error: builder for '/nix/store/${HASH}-x.drv' failed with exit code 1`,
    ].join("\n");
    expect(classifyFailure(output).diagnosis).toBe("other");
  });

  it("ignores a derivation path the build merely printed", () => {
    // stderr belongs to the build. A path it prints, unattached to nix's own
    // failure line, is a name it chose, and it becomes the grouping key on the
    // producer's dashboard.
    const output = `error: oops '/nix/store/${HASH}-victim.drv' is unhappy`;
    expect(classifyFailure(output).drv).toBeUndefined();
  });

  it("falls back to other when nothing matches confidently, rather than guessing", () => {
    const output =
      `error: builder for '/nix/store/${HASH}-x.drv' failed with exit code 1;\n` +
      "       > make: *** [Makefile:10: all] Error 2\n";
    expect(classifyFailure(output).diagnosis).toBe("other");
  });

  it("omits drv rather than guessing when none can be identified with confidence", () => {
    expect(classifyFailure("error: something went wrong, no derivation named here").drv).toBeUndefined();
  });
});

describe("excerpt: redaction runs before truncation", () => {
  it("removes a credential from the excerpt even when it straddles the 2048 byte cut point", () => {
    // The cut boundary is placed inside the credential. Truncating first would
    // keep its tail half, which no longer matches the whole shape the detector
    // looks for, and would leak.
    const cred = "ghp_" + "c".repeat(36); // 40 chars total
    const errorLine = `\nerror: builder for '/nix/store/${HASH}-x.drv' failed\n`;
    const K = 50; // leading filler before the credential
    const credStart = K + 1; // one delimiter space after the filler
    const target = credStart + 20; // where we want the tail-cut boundary to land: mid-credential
    // total length = K + 1(sep) + cred.length + 1(sep) + M + errorLine.length
    // boundary  = total - 2048 (ASCII throughout, so bytes == chars)
    // solve for M so boundary === target
    const M = 2048 + target - (K + 2 + cred.length + errorLine.length);
    expect(M).toBeGreaterThan(0);
    const output = "A".repeat(K) + " " + cred + " " + "B".repeat(M) + errorLine;
    // Sanity check on the construction itself, and that the boundary really
    // does land inside the credential's span as intended.
    expect(output.length).toBeGreaterThan(2048);
    expect(target).toBeGreaterThan(credStart);
    expect(target).toBeLessThan(credStart + cred.length);

    const excerpt = buildExcerpt(output);
    expect(excerpt).toBeDefined();
    expect(excerpt).not.toContain("c".repeat(10));
    expect(excerpt).not.toContain(cred);

    const r = classifyFailure(output);
    expect(r.excerpt).toBeDefined();
    expect(r.excerpt).not.toContain("c".repeat(10));
  });

  it("redacts a recognizable private key header wherever it sits in the log", () => {
    // Assembled at runtime so the repository's own secret scan does not read
    // this fixture as a key.
    const header = ["-----BEGIN OPENSSH PRIVATE", "KEY-----"].join(" ");
    const footer = ["-----END OPENSSH PRIVATE", "KEY-----"].join(" ");
    const output =
      `${header}\nb3BlbnNzaC1rZXk...\n${footer}\n` +
      `error: builder for '/nix/store/${HASH}-x.drv' failed with exit code 1`;
    const excerpt = buildExcerpt(output)!;
    expect(excerpt).not.toContain(header);
  });
});

describe("excerpt: control characters and bidi overrides", () => {
  it("strips C0/C1 controls but keeps newline and tab", () => {
    const output = "line one\ttabbed\x01\x07\x1b[31merror: bang\x9c\nline two";
    const excerpt = buildExcerpt(output)!;
    expect(excerpt).toContain("\n");
    expect(excerpt).toContain("\t");
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(excerpt)).toBe(false);
  });

  it("strips Unicode bidirectional override characters", () => {
    // Written as escapes, not as the characters themselves: a literal
    // bidi override in source is the thing this strips, and it should not be
    // in a file a person reads.
    const output = "error: \u202Eevil\u202C reversed text";
    const excerpt = buildExcerpt(output)!;
    expect(excerpt).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
  });
});

describe("excerpt: byte limit", () => {
  it("keeps an excerpt that is exactly at the limit intact", () => {
    const output = "x".repeat(2048);
    const excerpt = buildExcerpt(output)!;
    expect(Buffer.byteLength(excerpt, "utf8")).toBe(2048);
    expect(excerpt).toBe(output);
  });

  it("cuts an excerpt one byte over the limit down to the limit", () => {
    const output = "x".repeat(2049);
    const excerpt = buildExcerpt(output)!;
    expect(Buffer.byteLength(excerpt, "utf8")).toBe(2048);
  });
});

describe("bounded parsing", () => {
  it("does not hang or blow up on a pathological multi-megabyte log", () => {
    // The failure line sits at the very end, as it does in a real nix log;
    // classification bounds to the tail, so this must still be found even
    // though the log ahead of it is huge.
    const huge = "the quick brown fox jumps over the lazy dog\n".repeat(400_000); // ~17.6 MB
    const withFailure = huge + "error: writing to file: No space left on device\n";
    const start = Date.now();
    const r = classifyFailure(withFailure);
    const elapsedMs = Date.now() - start;
    expect(r.diagnosis).toBe("out-of-space");
    expect(elapsedMs).toBeLessThan(5000);
    expect(r.excerpt).toBeDefined();
    expect(Buffer.byteLength(r.excerpt!, "utf8")).toBeLessThanOrEqual(2048);
  });
});

describe("classifyFailure: the derivation nix names", () => {
  // Captured from a real reproducer run on the pinned Nix 3.21.0, and the same
  // wording appears on 2.34. The classifier only accepted the older "builder
  // for '...' failed", so every real failure reported no derivation at all.
  const REAL = [
    "building '/nix/store/" + HASH + "-vega-impure-probe.drv'...",
    "vega-impure-probe> /build/.attr-0l2: line 2: /usr/bin/sw_vers: No such file or directory",
    "error: Cannot build '/nix/store/" + HASH + "-vega-impure-probe.drv'.",
    "       Reason: builder failed with exit code 127.",
  ].join("\n");

  it("reads the derivation out of nix's own failure line", () => {
    expect(classifyFailure(REAL).drv).toBe(`/nix/store/${HASH}-vega-impure-probe.drv`);
  });

  it("still reads the older wording", () => {
    const old = `error: builder for '/nix/store/${HASH}-x.drv' failed with exit code 1;`;
    expect(classifyFailure(old).drv).toBe(`/nix/store/${HASH}-x.drv`);
  });

  it("ignores the line a build printed itself", () => {
    // A build controls its stderr, and this value becomes a grouping key.
    const forged = `some-build> Cannot build '/nix/store/${HASH}-not-really.drv'.`;
    expect(classifyFailure(forged).drv).toBeUndefined();
  });
});
