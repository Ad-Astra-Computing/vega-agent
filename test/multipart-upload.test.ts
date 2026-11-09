import { describe, it, expect, afterEach } from "vitest";
import { open, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlPlaneClient,
  MULTIPART_THRESHOLD_BYTES,
  partRanges,
  usesMultipart,
} from "../src/agent/client.js";

const MiB = 1024 * 1024;
const PART = 16 * MiB;
const base = "https://vega.test";
const fastRetry = { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {}, jitter: () => 0.5 };
const FILE_HASH = "sha256:1bn7y79qj9cs5l0hqjjvb9ccfg6w5qg5x6f0a3d9b1c2e3f4g5h6i";

describe("usesMultipart", () => {
  it("keeps a NAR under the threshold on the single PUT, and sends one at or over it in parts", () => {
    expect(usesMultipart(2 * MiB)).toBe(false);
    expect(usesMultipart(MULTIPART_THRESHOLD_BYTES - 1)).toBe(false);
    expect(usesMultipart(MULTIPART_THRESHOLD_BYTES)).toBe(true);
    expect(usesMultipart(6 * 1024 * MiB)).toBe(true); // past R2's single-PUT ceiling
  });

  it("sets the threshold above R2's 5 MiB part minimum, so a multipart NAR has full parts", () => {
    expect(MULTIPART_THRESHOLD_BYTES).toBeGreaterThan(5 * MiB);
  });
});

describe("partRanges", () => {
  it("splits into full parts and a shorter last part, covering every byte once", () => {
    expect(partRanges(10, 4)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 8 },
      { start: 8, end: 10 },
    ]);
  });

  it("gives an exact multiple a full last part and no empty one", () => {
    expect(partRanges(8, 4)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 8 },
    ]);
  });

  it("gives a NAR smaller than one part a single part", () => {
    expect(partRanges(3, 4)).toEqual([{ start: 0, end: 3 }]);
  });

  it("refuses sizes it cannot split", () => {
    for (const [size, part] of [
      [0, 4],
      [10, 0],
      [1.5, 4],
      [10, -1],
    ] as const) {
      expect(() => partRanges(size, part)).toThrow();
    }
  });
});

/**
 * A NAR file just over the threshold, sparse so it costs no real disk, with a
 * distinct marker at the start of every part and at the very end, so a part
 * read from the wrong offset is detectable from its bytes.
 */
const files: string[] = [];
async function narFile(size = MULTIPART_THRESHOLD_BYTES + 4321): Promise<{ file: string; bytes: () => Promise<Buffer> }> {
  const file = join(tmpdir(), `vega-mp-${Math.random().toString(36).slice(2)}.nar`);
  files.push(file);
  const fh = await open(file, "w");
  await fh.truncate(size);
  for (let off = 0, i = 1; off < size; off += PART, i++) {
    await fh.write(Buffer.from(`part-${i}-start`), 0, undefined, off);
  }
  await fh.write(Buffer.from("the-end"), 0, undefined, size - 7);
  await fh.close();
  return { file, bytes: async () => (await import("node:fs/promises")).readFile(file) };
}
afterEach(async () => {
  await Promise.all(files.splice(0).map((f) => rm(f, { force: true })));
});

const md5b64 = (b: Uint8Array) => createHash("md5").update(b).digest("base64");

interface FakeSession {
  id: string;
  /** The size the session was opened for (possibly wrong, to model a bad one). */
  size: number;
  parts: Map<number, Buffer>;
  status: "open" | "completing" | "completed" | "failed" | "aborted";
  expired: boolean;
}

/**
 * A control plane and R2 in one fake, holding state across client instances so
 * a test can model a process that dies and a fresh one that resumes, or two
 * processes on one session. It follows the edge's contract (session states, the
 * 409 bodies, `status` and `abort`) and checks on a part only what the presigned
 * URL binds there: the signed length and the `Content-MD5`. Whether production
 * R2 enforces those two on a query-signed UploadPart is not shown by any test
 * here; the NAR's real integrity check is the control plane's SHA-256 at
 * completion, which this fake does not model.
 */
class FakeVega {
  sessions = new Map<string, FakeSession>();
  puts: number[] = [];
  calls: string[] = [];
  aborted: string[] = [];
  /** Part number -> how many more PUTs of it to fail (status) or stall (0). */
  failPart = new Map<number, { times: number; status: number }>();
  /** Runs before a part PUT is handled, to change the world mid-upload. */
  beforePut?: (n: number, s: FakeSession) => void;
  /** What the other process does next, one step per `status` poll: each entry
   * becomes the session's state when polled. Empty means nothing changes. */
  statusScript: (FakeSession["status"] | { status: FakeSession["status"]; retryAfterMs: number })[] = [];
  multipart = true;
  existing = false;
  /** What the next completions do instead of completing: "busy" is the edge's
   * refusal while another request holds the verification lease, "drop" a
   * connection lost with no answer, "503" a transient error. */
  completeScript: ("busy" | "drop" | "503")[] = [];
  assembled: Buffer | null = null;
  private seq = 0;

  live(): FakeSession | undefined {
    return [...this.sessions.values()].find((s) => !s.expired && (s.status === "open" || s.status === "completing"));
  }

  /** Seed a session as an earlier process (or a bad client) left it. */
  seed(size: number, parts: [number, Buffer][] = []): FakeSession {
    const s: FakeSession = { id: String(++this.seq).padStart(32, "0"), size, parts: new Map(parts), status: "open", expired: false };
    this.sessions.set(s.id, s);
    return s;
  }

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    this.calls.push(`${req.method} ${url.pathname}`);
    if (url.pathname.startsWith("/api/cache/multipart/")) {
      if (!this.multipart) return new Response("not found", { status: 404 });
      const body = (await req.json()) as Record<string, unknown>;
      return this.control(url.pathname.slice("/api/cache/multipart/".length), body);
    }
    if (url.pathname === "/api/cache/upload-url") return Response.json({ url: "https://r2.test/single" });
    if (url.pathname === "/single") return new Response(null, { status: 200 });
    if (url.pathname === "/part") return this.r2Part(url, req, init);
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;

  private partLen(s: FakeSession, n: number): number {
    const count = Math.ceil(s.size / PART);
    return n < count ? PART : s.size - PART * (count - 1);
  }

  private view(s: FakeSession): Response {
    return Response.json({
      status: s.status,
      sessionId: s.id,
      fileSize: s.size,
      partSize: PART,
      partCount: Math.ceil(s.size / PART),
      confirmedParts: [...s.parts.keys()].sort((x, y) => x - y),
    });
  }

  private control(op: string, b: Record<string, unknown>): Response {
    if (op === "create") {
      if (this.existing) return Response.json({ status: "exists" });
      const live = this.live();
      if (live !== undefined) {
        if (live.size !== b.fileSize) {
          return Response.json({ error: "different fileSize", sessionId: live.id }, { status: 409 });
        }
        return this.view(live);
      }
      return this.view(this.seed(b.fileSize as number));
    }
    const s = this.sessions.get(b.sessionId as string);
    if (s === undefined) return Response.json({ error: "no such upload session" }, { status: 404 });
    if (op === "status") {
      const next = this.statusScript.shift();
      if (next === undefined) return Response.json({ status: s.status });
      if (typeof next === "string") {
        s.status = next;
        return Response.json({ status: s.status });
      }
      s.status = next.status;
      return Response.json(next);
    }
    if (op === "abort") {
      this.aborted.push(s.id);
      if (s.status === "aborted") return Response.json({ status: "aborted" });
      if (s.status !== "open") return Response.json({ error: "conflict", state: s.status }, { status: 409 });
      s.status = "aborted";
      return Response.json({ status: "aborted" });
    }
    if (s.expired) return Response.json({ error: "upload session expired" }, { status: 410 });
    if (op === "part-url" || op === "part") {
      if (s.status !== "open") return Response.json({ error: "conflict", state: s.status }, { status: 409 });
    }
    if (op === "part-url") {
      const n = b.partNumber as number;
      const q = new URLSearchParams({ n: String(n), md5: b.md5 as string, len: String(this.partLen(s, n)), id: s.id });
      return Response.json({ url: `https://r2.test/part?${q}`, size: this.partLen(s, n) });
    }
    if (op === "part") {
      if (b.etag !== `"etag-${b.partNumber}"`) return Response.json({ error: "bad etag" }, { status: 400 });
      return Response.json({ confirmed: s.parts.size });
    }
    if (op === "complete") {
      if (s.status === "completed") return Response.json({ status: "completed" });
      const act = this.completeScript.shift();
      if (act === "busy") {
        s.status = "completing";
        return Response.json({ error: "conflict", state: "completing", retryAfterMs: 1000 }, { status: 409 });
      }
      if (act === "drop") throw new TypeError("fetch failed");
      if (act === "503") return new Response("busy", { status: 503 });
      if (s.status !== "open" && s.status !== "completing") {
        return Response.json({ error: "conflict", state: s.status }, { status: 409 });
      }
      const all = [];
      for (let i = 1; i <= Math.ceil(s.size / PART); i++) {
        const p = s.parts.get(i);
        if (p === undefined) return Response.json({ error: "parts missing", missing: [i] }, { status: 409 });
        all.push(p);
      }
      this.assembled = Buffer.concat(all);
      s.status = "completed";
      return Response.json({ status: "completed" });
    }
    return new Response("unexpected", { status: 500 });
  }

  private async r2Part(url: URL, req: Request, init?: RequestInit): Promise<Response> {
    const n = Number(url.searchParams.get("n"));
    const s = this.sessions.get(url.searchParams.get("id")!)!;
    this.beforePut?.(n, s);
    this.puts.push(n);
    const fail = this.failPart.get(n);
    if (fail !== undefined && fail.times > 0) {
      fail.times--;
      if (fail.status === 0) {
        // Accept the connection and never read a byte: a stall.
        return await new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
        });
      }
      return new Response(null, { status: fail.status });
    }
    if ([...req.headers.keys()].some((h) => h.startsWith("x-amz-checksum"))) {
      return new Response("R2 UploadPart takes no x-amz-checksum-*", { status: 400 });
    }
    const bytes = Buffer.from(await req.arrayBuffer());
    // The two things the URL is signed for: the length, then the MD5.
    if (String(bytes.byteLength) !== url.searchParams.get("len")) return new Response("SignatureDoesNotMatch", { status: 403 });
    const sent = req.headers.get("content-md5");
    if (sent !== url.searchParams.get("md5") || sent !== md5b64(bytes)) return new Response("BadDigest", { status: 400 });
    if (s.status !== "open") return new Response("NoSuchUpload", { status: 404 });
    s.parts.set(n, bytes);
    return new Response(null, { status: 200, headers: { etag: `"etag-${n}"` } });
  }
}

const SIZE = MULTIPART_THRESHOLD_BYTES + 4321;
const client = (vega: FakeVega, retry = {}) => new ControlPlaneClient(base, "jwt", vega.fetch, { ...fastRetry, ...retry });
const upload = (vega: FakeVega, file: string, retry = {}) => client(vega, retry).uploadNar("nar/x.nar.zst", FILE_HASH, file, "c2hh");

describe("uploadNar in parts", () => {
  it("leaves a NAR under the threshold on the single presigned PUT", async () => {
    const vega = new FakeVega();
    const { file } = await narFile(MULTIPART_THRESHOLD_BYTES - 1);
    await upload(vega, file);
    expect(vega.calls).toEqual(["POST /api/cache/upload-url", "PUT /single"]);
  });

  it("sends each part from its own offset with its Content-MD5 and no SHA-256 header", async () => {
    const vega = new FakeVega();
    const { file, bytes } = await narFile();
    await upload(vega, file);
    expect(vega.puts).toEqual([1, 2, 3, 4, 5]);
    const parts = vega.live() ?? [...vega.sessions.values()][0]!;
    for (let i = 1; i <= 4; i++) {
      expect(parts.parts.get(i)!.byteLength).toBe(PART);
      expect(parts.parts.get(i)!.subarray(0, 12).toString()).toBe(`part-${i}-start`.slice(0, 12));
    }
    expect(parts.parts.get(5)!.byteLength).toBe(4321);
    expect(vega.assembled!.equals(await bytes())).toBe(true);
    expect(vega.calls.at(-1)).toBe("POST /api/cache/multipart/complete");
  });

  it("resumes in a fresh process from the parts the control plane holds, re-sending none of them", async () => {
    const vega = new FakeVega();
    const { file, bytes } = await narFile();
    // The first process dies at part 3 with an error no retry fixes.
    vega.failPart.set(3, { times: 1, status: 400 });
    await expect(upload(vega, file)).rejects.toThrow(/part 3/);
    expect(vega.puts).toEqual([1, 2, 3]);

    // A new process: a new client, nothing carried over but the file on disk.
    vega.puts = [];
    await upload(vega, file);
    expect(vega.puts).toEqual([3, 4, 5]);
    expect(vega.assembled!.equals(await bytes())).toBe(true);
  });

  it("skips exactly the parts the control plane reports, not what the client believes", async () => {
    const vega = new FakeVega();
    const { file, bytes } = await narFile();
    const all = await bytes();
    vega.seed(SIZE, [
      [2, all.subarray(PART, 2 * PART)],
      [4, all.subarray(3 * PART, 4 * PART)],
    ]);
    await upload(vega, file);
    expect(vega.puts).toEqual([1, 3, 5]);
  });

  it("retries a stalled part on its own, without re-sending the parts before it", async () => {
    const vega = new FakeVega();
    const { file, bytes } = await narFile();
    vega.failPart.set(2, { times: 1, status: 0 });
    await upload(vega, file, { uploadStallMs: 50 });
    expect(vega.puts).toEqual([1, 2, 2, 3, 4, 5]);
    expect(vega.assembled!.equals(await bytes())).toBe(true);
  });

  it("retries a part that hit a transient R2 error", async () => {
    const vega = new FakeVega();
    const { file } = await narFile();
    vega.failPart.set(4, { times: 2, status: 503 });
    await upload(vega, file);
    expect(vega.puts).toEqual([1, 2, 3, 4, 4, 4, 5]);
  });

  it("reports progress across the whole NAR, ending at its full size", async () => {
    const vega = new FakeVega();
    const { file } = await narFile();
    const seen: [number, number][] = [];
    await client(vega).uploadNar("nar/x.nar.zst", FILE_HASH, file, "c2hh", (moved, total) => seen.push([moved, total]));
    expect(seen.every(([, t]) => t === SIZE)).toBe(true);
    expect(seen.at(-1)![0]).toBe(SIZE);
  });

  it("uploads nothing when the control plane already holds the verified NAR", async () => {
    const vega = new FakeVega();
    vega.existing = true;
    const { file } = await narFile();
    await upload(vega, file);
    expect(vega.puts).toEqual([]);
    expect(vega.calls).toEqual(["POST /api/cache/multipart/create"]);
  });

  it("falls back to the single PUT against a control plane without the multipart routes", async () => {
    const vega = new FakeVega();
    vega.multipart = false;
    const { file } = await narFile();
    await upload(vega, file);
    expect(vega.calls).toEqual(["POST /api/cache/multipart/create", "POST /api/cache/upload-url", "PUT /single"]);
  });

  it("does not fall back to a single PUT when a multipart part is refused", async () => {
    const vega = new FakeVega();
    vega.failPart.set(1, { times: 1, status: 403 }); // a real refusal, inside the URL's window
    const { file } = await narFile();
    await expect(upload(vega, file)).rejects.toThrow(/403/);
    expect(vega.calls).not.toContain("POST /api/cache/upload-url");
  });
});

describe("uploadNar in parts: a session declared with the wrong size", () => {
  it("aborts the impossible session and completes in a fresh, correctly sized one", async () => {
    const vega = new FakeVega();
    const { file, bytes } = await narFile();
    const bad = vega.seed(SIZE + PART); // one part too many: its last part can never be sent
    await upload(vega, file);
    expect(bad.status).toBe("aborted");
    const fresh = [...vega.sessions.values()].find((s) => s.id !== bad.id)!;
    expect(fresh.size).toBe(SIZE);
    expect(fresh.status).toBe("completed");
    expect(vega.assembled!.equals(await bytes())).toBe(true);
    // A later invocation is not handed the broken session again.
    vega.existing = true;
    await upload(vega, file);
  });

  it("aborts rather than retries when a part's signed length disagrees with the file", async () => {
    const vega = new FakeVega();
    const { file } = await narFile();
    // The session's view agrees with the file but its parts are signed for
    // another length: R2 would refuse every attempt, so none is made.
    const bad = vega.seed(SIZE);
    const realView = (vega as unknown as { partLen: (s: FakeSession, n: number) => number }).partLen.bind(vega);
    (vega as unknown as { partLen: (s: FakeSession, n: number) => number }).partLen = (s, n) =>
      s.id === bad.id ? realView(s, n) + 1 : realView(s, n);
    await upload(vega, file);
    expect(bad.status).toBe("aborted");
    expect(vega.puts.length).toBe(5); // only the fresh session's parts were sent
  });
});

describe("uploadNar in parts: another process on the same session", () => {
  it("waits for another process's completion instead of reporting failure", async () => {
    const vega = new FakeVega();
    const { file } = await narFile();
    // Process A finished the parts and is completing while this process
    // (B, holding the same identity) is still uploading part 5.
    vega.beforePut = (n, s) => {
      if (n === 5) s.status = "completing";
    };
    vega.statusScript = ["completing", "completing", "completed"];
    await upload(vega, file);
    expect(vega.calls.filter((c) => c.endsWith("/status")).length).toBe(3);
    expect(vega.calls).not.toContain("POST /api/cache/multipart/complete");
  });

  it("takes over when the other process's completion does not succeed", async () => {
    const vega = new FakeVega();
    const { file, bytes } = await narFile();
    let first = true;
    vega.beforePut = (n, s) => {
      if (n === 5 && first) {
        first = false;
        s.status = "completing"; // A starts completing...
      }
    };
    vega.statusScript = ["completing", "open"]; // ...and R2 refuses it, reopening the session
    await upload(vega, file);
    // This process resumed the reopened session and finished it itself.
    expect(vega.sessions.size).toBe(1);
    expect(vega.puts).toEqual([1, 2, 3, 4, 5, 5]);
    expect(vega.assembled!.equals(await bytes())).toBe(true);
  });

  it("waits out a completion that holds the verification lease instead of hashing again", async () => {
    // Its own earlier completion request timed out on this side and is still
    // hashing on the control plane, which refuses the repeat as completing.
    const vega = new FakeVega();
    const { file } = await narFile();
    vega.completeScript = ["busy"];
    vega.statusScript = ["completing", "completed"];
    await upload(vega, file);
    expect(vega.calls.filter((c) => c.endsWith("/complete")).length).toBe(1);
    expect(vega.calls.filter((c) => c.endsWith("/status")).length).toBe(2);
  });

  it("resumes cleanly when the session it was completing is found already completed", async () => {
    const vega = new FakeVega();
    const { file } = await narFile();
    const s = vega.seed(SIZE);
    s.status = "completing"; // a previous process got as far as completing
    vega.statusScript = ["completed"];
    await upload(vega, file);
    expect(vega.puts).toEqual([]);
  });
});

describe("uploadNar in parts: a completion that dies mid-verification", () => {
  it("takes the completion over once the lease the control plane reports has lapsed", async () => {
    const vega = new FakeVega();
    const { file } = await narFile();
    const slept: number[] = [];
    // An earlier holder is verifying, then dies: its lease runs down to zero.
    vega.completeScript = ["busy"];
    vega.statusScript = [
      { status: "completing", retryAfterMs: 60_000 },
      { status: "completing", retryAfterMs: 1_500 },
      { status: "completing", retryAfterMs: 0 },
    ];
    await upload(vega, file, { sleep: async (ms: number) => void slept.push(ms) });
    expect(vega.calls.filter((c) => c.endsWith("/complete")).length).toBe(2); // refused, then the takeover
    expect(vega.calls.at(-1)).toBe("POST /api/cache/multipart/complete");
    // It polled while waiting and took over only once the server said the lease
    // was gone; the short wait covers what was left plus a margin.
    expect(slept).toEqual([5_000, 3_500]);
  });

  it("goes back to waiting when another process wins the takeover", async () => {
    const vega = new FakeVega();
    const { file } = await narFile();
    vega.completeScript = ["busy", "busy"];
    // Its takeover is refused because another process took the lease first;
    // that process then finishes.
    vega.statusScript = [{ status: "completing", retryAfterMs: 0 }, "completed"];
    await upload(vega, file);
    expect(vega.calls.filter((c) => c.endsWith("/complete")).length).toBe(2);
    expect(vega.calls.at(-1)).toBe("POST /api/cache/multipart/status");
  });

  it("does not resend a completion whose answer was lost; it asks the status", async () => {
    for (const lost of ["drop", "503"] as const) {
      const vega = new FakeVega();
      const { file } = await narFile();
      vega.completeScript = [lost];
      vega.statusScript = [{ status: "completing", retryAfterMs: 2_000 }, "completed"];
      await upload(vega, file);
      // The generic retry loop would have resent it at once and taken a second
      // lease beside a hash that may still be running.
      expect(vega.calls.filter((c) => c.endsWith("/complete")).length, lost).toBe(1);
      expect(vega.calls.filter((c) => c.endsWith("/status")).length, lost).toBe(2);
    }
  });

  it("reports a completion that keeps dying rather than taking it over for ever", async () => {
    const vega = new FakeVega();
    const { file } = await narFile();
    vega.completeScript = ["busy", "busy", "busy", "busy"];
    vega.statusScript = Array.from({ length: 10 }, () => ({ status: "completing" as const, retryAfterMs: 0 }));
    await expect(upload(vega, file)).rejects.toThrow(/keeps dying/);
  });
});

describe("uploadNar in parts: recovery within one invocation", () => {
  it("opens a fresh session when its session is aborted under it", async () => {
    const vega = new FakeVega();
    const { file, bytes } = await narFile();
    let done = false;
    vega.beforePut = (n, s) => {
      if (n === 3 && !done) {
        done = true;
        s.status = "aborted";
      }
    };
    await upload(vega, file);
    expect(vega.assembled!.equals(await bytes())).toBe(true);
    expect([...vega.sessions.values()].filter((s) => s.status === "completed").length).toBe(1);
  });

  it("opens a fresh session when its session expires under it", async () => {
    const vega = new FakeVega();
    const { file, bytes } = await narFile();
    let done = false;
    vega.beforePut = (n, s) => {
      if (n === 2 && !done) {
        done = true;
        s.expired = true;
      }
    };
    await upload(vega, file);
    expect(vega.assembled!.equals(await bytes())).toBe(true);
  });

  it("gives up after a bounded number of fresh sessions rather than looping", async () => {
    const vega = new FakeVega();
    const { file } = await narFile();
    vega.beforePut = (_n, s) => {
      s.status = "aborted";
    };
    await expect(upload(vega, file)).rejects.toThrow(/session ended 4 times/);
  });
});
