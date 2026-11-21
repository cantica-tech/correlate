import { afterEach, describe, expect, it } from "vitest";
import { download, request, stream, sumpUrl } from "../client.js";
import {
  REQUEST_TIMEOUT_MS,
  STREAM_IDLE_MS,
  SumpCallError,
  SumpHttpError,
  SumpTimeoutError,
} from "../errors.js";
import type { SumpEvent } from "../sse.js";
import { neverAnswers, serve, since, stallsAfterFirstChunk, type TestServer } from "./servers.js";

// br-CONN-000005-sJpO9KMY, br-CONN-000009-sJpO9KMY (REQ-000007-sJpO9KMY
// Requirement 2): every Sump call is time-bounded.

const quiet = { warn: () => {} };
let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Collects what a logger was told. */
function recorder() {
  const lines: string[] = [];
  return { lines, logger: { warn: (line: string) => lines.push(line) } };
}

describe("br-CONN-000005-sJpO9KMY: request", () => {
  it("sends JSON and returns the JSON answer", async () => {
    server = await serve((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, url: req.url, body: JSON.parse(body) }));
      });
    });
    const answer = await request(server.sump, "POST", "/records", {
      body: { a: 1 },
      query: { limit: 5, skip: undefined },
    });
    expect(answer).toEqual({ method: "POST", url: "/records?limit=5", body: { a: 1 } });
  });

  it("fails with a total timeout naming the Sump, the call and the limit", async () => {
    server = await serve(neverAnswers);
    const { lines, logger } = recorder();
    const start = performance.now();
    const error = await request(server.sump, "GET", "/health", { timeoutMs: 100, logger }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SumpTimeoutError);
    expect(error).toMatchObject({
      sump: "test",
      method: "GET",
      path: "/health",
      limit: "total",
      limitMs: 100,
    });
    expect(since(start)).toBeLessThan(2_000);
    expect(lines).toEqual([(error as Error).message]);
  });

  it("counts reading the answer against the total limit", async () => {
    server = await serve(stallsAfterFirstChunk("application/json", "{"));
    const error = await request(server.sump, "GET", "/health", {
      timeoutMs: 100,
      logger: quiet,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ limit: "total" });
  });

  it("reports an error status with the Sump's detail", async () => {
    server = await serve((_req, res) => {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "bad cursor" }));
    });
    const error = await request(server.sump, "GET", "/records").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SumpHttpError);
    expect(error).toMatchObject({ status: 422, detail: "bad cursor" });
  });

  it("uses 30 s by default", () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN, 2 ** 31])(
    "refuses a limit of %s: no call can be unbounded",
    async (timeoutMs) => {
      const sump = { name: "test", baseUrl: "http://127.0.0.1:1" };
      await expect(request(sump, "GET", "/health", { timeoutMs })).rejects.toThrow(SumpCallError);
    },
  );

  it.each(["health", "//elsewhere.example/x", "/../../x"])("keeps path %s on the Sump", (path) => {
    const sump = { name: "test", baseUrl: "http://127.0.0.1:8765" };
    let url: URL | undefined;
    try {
      url = sumpUrl(sump, path);
    } catch (error) {
      expect(error).toBeInstanceOf(SumpCallError);
    }
    if (url) expect(url.origin).toBe("http://127.0.0.1:8765");
  });
});

describe("br-CONN-000005-sJpO9KMY: download", () => {
  it("completes a long but steady download", async () => {
    server = await serve((_req, res) => {
      res.writeHead(200);
      let n = 0;
      const timer = setInterval(() => {
        res.write(`${n}`);
        n += 1;
        if (n === 6) {
          clearInterval(timer);
          res.end();
        }
      }, 40);
    });
    const chunks: string[] = [];
    await download(server.sump, "/export", (c) => void chunks.push(new TextDecoder().decode(c)), {
      idleMs: 150,
    });
    expect(chunks.join("")).toBe("012345");
  });

  it("fails with an idle timeout when the bytes stop", async () => {
    server = await serve(stallsAfterFirstChunk("application/octet-stream", "abc"));
    const chunks: Uint8Array[] = [];
    const error = await download(server.sump, "/export", (c) => void chunks.push(c), {
      idleMs: 100,
      logger: quiet,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SumpTimeoutError);
    expect(error).toMatchObject({ limit: "idle", limitMs: 100 });
    expect(chunks).toHaveLength(1);
  });
});

describe("br-CONN-000009-sJpO9KMY: stream", () => {
  it("waits 45 s of silence by default: three missed heartbeats", () => {
    expect(STREAM_IDLE_MS).toBe(45_000);
  });

  it("delivers events and stays open on heartbeats alone", async () => {
    server = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: log\nid: 1\ndata: {"a":1}\n\n');
      let beats = 0;
      const timer = setInterval(() => {
        res.write(": keep-alive\n\n");
        beats += 1;
        if (beats === 6) {
          clearInterval(timer);
          res.end("data: last\n\n");
        }
      }, 40);
    });
    const events: SumpEvent[] = [];
    const open = stream(server.sump, "/live", (e) => events.push(e), { idleMs: 150 });
    await open.done;
    expect(events).toEqual([
      { event: "log", id: "1", data: '{"a":1}' },
      { event: "message", id: "1", data: "last" },
    ]);
  });

  it("fails a silent stream with an idle timeout", async () => {
    server = await serve(stallsAfterFirstChunk("text/event-stream", "data: one\n\n"));
    const events: SumpEvent[] = [];
    const open = stream(server.sump, "/live", (e) => events.push(e), {
      idleMs: 100,
      logger: quiet,
    });
    const error = await open.done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SumpTimeoutError);
    expect(error).toMatchObject({ limit: "idle", path: "/live" });
    expect(events.map((e) => e.data)).toEqual(["one"]);
  });

  it("ends quietly when closed", async () => {
    server = await serve(stallsAfterFirstChunk("text/event-stream", ": hi\n\n"));
    const open = stream(server.sump, "/live", () => {}, { idleMs: 5_000 });
    open.close();
    await expect(open.done).resolves.toBeUndefined();
  });
});
