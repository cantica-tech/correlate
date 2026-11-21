import { afterEach, describe, expect, it } from "vitest";
import { handleSumpRequest, registerSumpIpc } from "../../sump/ipc.js";
import { neverAnswers, serve, type TestServer } from "../../sump/tests/servers.js";
import { Lifecycle } from "../lifecycle.js";

// br-SUMP-000011-sJpO9KMY (REQ-000013-sJpO9KMY Requirements 3 and 4): every
// call's outcome moves a Sump between active and unreachable; the renderer
// reads states and cannot set them.

const quiet = { info: () => {} };
const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function answering(status: number) {
  const s = await serve((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end("{}");
  });
  servers.push(s);
  return s;
}

describe("br-SUMP-000011-sJpO9KMY: calls move Sumps", () => {
  it.each([200, 401, 500])("an answer with %i makes the Sump active", async (status) => {
    const s = await answering(status);
    const l = new Lifecycle(undefined, undefined, quiet);
    await handleSumpRequest(
      { sump: "x", method: "GET", path: "/" },
      () => s.sump,
      undefined,
      undefined,
      undefined,
      l,
    );
    expect(l.get("x")?.state).toBe("active");
  });

  it("a timeout makes it unreachable", async () => {
    const s = await serve(neverAnswers);
    servers.push(s);
    const l = new Lifecycle(undefined, undefined, quiet);
    l.reachable("x", "start");
    const original = console.warn;
    console.warn = () => {};
    try {
      await handleSumpRequest(
        { sump: "x", method: "GET", path: "/", timeoutMs: 50 },
        () => s.sump,
        undefined,
        undefined,
        undefined,
        l,
      );
    } finally {
      console.warn = original;
    }
    expect(l.get("x")?.state).toBe("unreachable");
  });

  it("a refused call says nothing about the Sump", async () => {
    const l = new Lifecycle(undefined, undefined, quiet);
    await handleSumpRequest(
      { sump: "x", method: "GET", path: "//elsewhere" },
      () => ({ name: "x", baseUrl: "http://127.0.0.1:1" }),
      undefined,
      undefined,
      undefined,
      l,
    );
    expect(l.get("x")).toBeUndefined();
  });

  it("lists states on sump:states and offers no way to set one", () => {
    const l = new Lifecycle(undefined, undefined, quiet);
    l.reachable("x", "start");
    const channels = new Map<string, (event: unknown, message: unknown) => unknown>();
    registerSumpIpc(
      { handle: (c, h) => void channels.set(c, h as never) },
      () => undefined,
      undefined,
      undefined,
      undefined,
      l,
    );
    expect([...channels.keys()].sort()).toEqual(["sump:request", "sump:states"]);
    expect(channels.get("sump:states")?.({}, undefined)).toMatchObject([
      { id: "x", state: "active" },
    ]);
  });
});
