import { afterEach, describe, expect, it } from "vitest";
import { configuredSumps, DEFAULT_SUMP_URL } from "../../index.js";
import type { Sump } from "../errors.js";
import { handleSumpRequest, registerSumpIpc, SUMP_REQUEST_CHANNEL } from "../ipc.js";
import { neverAnswers, serve, type TestServer } from "./servers.js";

// br-CONN-000008-sJpO9KMY (REQ-000007-sJpO9KMY Requirement 3): the renderer's
// only way to a Sump, time-bounded like every call (br-CONN-000005-sJpO9KMY).

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const only = (sump: Sump) => (name: string) => (name === sump.name ? sump : undefined);

describe("br-CONN-000008-sJpO9KMY: sump:request", () => {
  it("answers through the client", async () => {
    server = await serve((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: req.url }));
    });
    const reply = await handleSumpRequest(
      { sump: "test", method: "GET", path: "/health", query: { a: 1 } },
      only(server.sump),
    );
    expect(reply).toEqual({ ok: true, value: { url: "/health?a=1" } });
  });

  it("returns a timeout as a plain object", async () => {
    server = await serve(neverAnswers);
    const original = console.warn;
    console.warn = () => {};
    try {
      const reply = await handleSumpRequest(
        { sump: "test", method: "GET", path: "/health", timeoutMs: 50 },
        only(server.sump),
      );
      expect(reply).toMatchObject({
        ok: false,
        error: { kind: "timeout", limit: "total", limitMs: 50 },
      });
    } finally {
      console.warn = original;
    }
  });

  it("returns an error status with the Sump's detail", async () => {
    server = await serve((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Not Found" }));
    });
    const reply = await handleSumpRequest(
      { sump: "test", method: "GET", path: "/nope" },
      only(server.sump),
    );
    expect(reply).toMatchObject({ ok: false, error: { kind: "http", status: 404 } });
  });

  it.each([
    [undefined, "sump must be"],
    [{ sump: "test", method: "TRACE", path: "/" }, "method must be"],
    [{ sump: "test", method: "GET", path: 7 }, "path must be"],
    [{ sump: "test", method: "GET", path: "/", timeoutMs: "1" }, "timeoutMs must be"],
    [{ sump: "test", method: "GET", path: "/", timeoutMs: 0 }, "timeoutMs must be"],
    [{ sump: "other", method: "GET", path: "/" }, 'no Sump named "other"'],
    [{ sump: "test", method: "GET", path: "//evil.example/" }, 'single "/"'],
  ])("refuses %j", async (message, why) => {
    const sump = { name: "test", baseUrl: "http://127.0.0.1:1" };
    const reply = await handleSumpRequest(message, only(sump));
    expect(reply).toMatchObject({ ok: false, error: { kind: "refused" } });
    if (!reply.ok) expect(reply.error.message).toContain(why);
  });

  it("registers one handler on the channel", () => {
    const channels: string[] = [];
    registerSumpIpc({ handle: (channel) => void channels.push(channel) }, () => undefined);
    expect(channels).toEqual([SUMP_REQUEST_CHANNEL]);
  });
});

describe("configured Sumps", () => {
  it("knows one local Sump, at the Sump's default address unless set", () => {
    expect(configuredSumps({})("local")).toEqual({ name: "local", baseUrl: DEFAULT_SUMP_URL });
    expect(configuredSumps({ CORRELATE_SUMP_URL: "http://127.0.0.1:9000" })("local")).toEqual({
      name: "local",
      baseUrl: "http://127.0.0.1:9000",
    });
    expect(configuredSumps({})("other")).toBeUndefined();
  });

  it("refuses an invalid address at startup", () => {
    expect(() => configuredSumps({ CORRELATE_SUMP_URL: "not a url" })).toThrow();
  });
});
