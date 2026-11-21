import type { IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { configuredSumps } from "../../index.js";
import { download, logout, request, stream } from "../client.js";
import { handleSumpRequest } from "../ipc.js";
import { SessionTokens } from "../tokens.js";
import { serve, type TestServer } from "./servers.js";

// br-CONN-000004-sJpO9KMY (REQ-000010-sJpO9KMY Requirement 4): the app keeps
// session tokens in memory and sends them on every call.

const quiet = { warn: () => {} };
let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A server that records each request's headers and path, answering per `answer`. */
async function recording(answer: (path: string) => [number, string, string]) {
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
  server = await serve((req, res) => {
    seen.push({ path: req.url ?? "", headers: req.headers });
    const [status, type, body] = answer(req.url ?? "");
    res.writeHead(status, { "content-type": type });
    res.end(body);
  });
  return seen;
}

const ok = (path: string): [number, string, string] =>
  path === "/live"
    ? [200, "text/event-stream", "data: x\n\n"]
    : [200, "application/json", '{"ok":true}'];

describe("br-CONN-000004-sJpO9KMY: the app sends its token", () => {
  it("sends Authorization: Bearer on requests, downloads and streams", async () => {
    const seen = await recording(ok);
    const sump = { ...(server as TestServer).sump, token: "t0k3n" };
    await request(sump, "GET", "/plugins");
    await download(sump, "/export", () => {});
    await stream(sump, "/live", () => {}).done;
    expect(seen.map((s) => s.headers.authorization)).toEqual([
      "Bearer t0k3n",
      "Bearer t0k3n",
      "Bearer t0k3n",
    ]);
    expect(seen.every((s) => !s.path.includes("t0k3n"))).toBe(true);
  });

  it("sends no Authorization header without a token", async () => {
    const seen = await recording(ok);
    await request((server as TestServer).sump, "GET", "/health");
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it("reports a refused token as login-needed, and forgets it", async () => {
    await recording(() => [
      401,
      "application/json",
      '{"detail":"a valid session token is needed"}',
    ]);
    const tokens = new SessionTokens();
    tokens.set("test", "stale");
    const sump = (server as TestServer).sump;
    const resolve = (name: string) =>
      name === "test" ? { ...sump, token: tokens.get("test") } : undefined;
    const reply = await handleSumpRequest(
      { sump: "test", method: "GET", path: "/plugins" },
      resolve,
      tokens,
    );
    expect(reply).toMatchObject({ ok: false, error: { kind: "login-needed" } });
    expect(tokens.get("test")).toBeUndefined();
  });

  it("logs out: the Sump revokes, the app forgets", async () => {
    const seen = await recording(() => [204, "application/json", ""]);
    const tokens = new SessionTokens();
    tokens.set("test", "t0k3n");
    const sump = { ...(server as TestServer).sump, token: "t0k3n" };
    await logout(sump, () => tokens.forget("test"));
    expect(seen.map((s) => [s.path, s.headers.authorization])).toEqual([
      ["/session/logout", "Bearer t0k3n"],
    ]);
    expect(tokens.sumps()).toEqual([]);
  });

  it("forgets the token even when the Sump cannot be reached", async () => {
    const tokens = new SessionTokens();
    tokens.set("gone", "t0k3n");
    const sump = { name: "gone", baseUrl: "http://127.0.0.1:1", token: "t0k3n" };
    await logout(sump, () => tokens.forget("gone"), { timeoutMs: 1_000, logger: quiet });
    expect(tokens.get("gone")).toBeUndefined();
  });

  it("gives the local Sump the token from CORRELATE_SUMP_TOKEN, in memory", () => {
    const tokens = new SessionTokens();
    const resolve = configuredSumps({ CORRELATE_SUMP_TOKEN: "dev" }, tokens);
    expect(resolve("local")?.token).toBe("dev");
    tokens.forget("local");
    expect(resolve("local")?.token).toBeUndefined();
  });
});
