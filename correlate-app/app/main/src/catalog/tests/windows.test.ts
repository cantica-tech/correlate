import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configuredSumps } from "../../index.js";
import { handleSumpRequest, registerSumpIpc } from "../../sump/ipc.js";
import { serve, type TestServer } from "../../sump/tests/servers.js";
import { SessionTokens } from "../../sump/tokens.js";
import { Catalog, LOCAL_ID } from "../catalog.js";
import { ActiveSumps } from "../windows.js";

// br-SUMP-000010-sJpO9KMY (REQ-000012-sJpO9KMY Requirement 3): any number of
// Sumps, one active per window.

let dir: string;
let catalog: Catalog;
let server: TestServer | undefined;
const remote = { kind: "remote" as const, sumpPort: 8765, sshTarget: "ops@box" };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "windows-test-"));
  catalog = Catalog.open(path.join(dir, "catalog.db"));
});
afterEach(async () => {
  catalog.close();
  await server?.close();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("br-SUMP-000010-sJpO9KMY: one active Sump per window", () => {
  it("starts windows on the last active Sump, else the local one", () => {
    const active = new ActiveSumps(catalog);
    expect(active.open(1)).toBe(LOCAL_ID);
    const a = catalog.recordConnect(remote);
    active.set(1, a.id);
    expect(active.open(2)).toBe(a.id);
    expect(active.describe(2)).toEqual({ id: a.id, name: "ops@box", kind: "remote" });
  });

  it("changes only the window it is told to", () => {
    const active = new ActiveSumps(catalog);
    const a = catalog.recordConnect(remote);
    const b = catalog.recordConnect({ ...remote, sshTarget: "other" });
    active.open(1);
    active.open(2);
    active.set(1, a.id);
    active.set(2, b.id);
    expect([active.get(1), active.get(2)]).toEqual([a.id, b.id]);
    active.close(1);
    expect(active.get(1)).toBeUndefined();
    expect(active.describe(1)).toBeNull();
    expect(active.get(2)).toBe(b.id);
  });

  it("refuses an unknown or retired Sump", () => {
    const active = new ActiveSumps(catalog);
    const a = catalog.recordConnect(remote);
    catalog.retire(a.id);
    expect(() => active.set(1, a.id)).toThrow(/no Sump/);
    expect(() => active.set(1, "nope")).toThrow(/no Sump/);
  });

  it("sends a request without a Sump to the window's active one", async () => {
    server = await serve((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: req.url }));
    });
    const port = Number(new URL(server.sump.baseUrl).port);
    catalog.recordConnect({ kind: "local", sumpPort: port });
    const active = new ActiveSumps(catalog);
    active.open(7);
    const handlers = new Map<string, (event: unknown, message: unknown) => unknown>();
    const tokens = new SessionTokens();
    registerSumpIpc(
      { handle: (channel, listener) => void handlers.set(channel, listener as never) },
      configuredSumps({}, tokens, catalog),
      tokens,
      undefined,
      active,
    );
    const ask = (channel: string, message?: unknown) =>
      (handlers.get(channel) as (e: unknown, m: unknown) => unknown)(
        { sender: { id: 7 } },
        message,
      );
    expect(await ask("sump:active")).toEqual({ id: LOCAL_ID, name: "This machine", kind: "local" });
    expect(await ask("sump:request", { method: "GET", path: "/health" })).toEqual({
      ok: true,
      value: { url: "/health" },
    });
  });

  it("resolves Sumps from the catalog: local ones by port, not retired ones", () => {
    const resolve = configuredSumps({}, new SessionTokens(), catalog);
    catalog.recordConnect({ kind: "local", sumpPort: 9999 });
    expect(resolve(LOCAL_ID)?.baseUrl).toBe("http://127.0.0.1:9999");
    const a = catalog.recordConnect(remote);
    expect(resolve(a.id)).toBeUndefined(); // reached through its SSH forward, Item 17
    catalog.retire(LOCAL_ID);
    expect(resolve(LOCAL_ID)).toBeUndefined();
  });

  it("refuses a request no window or message names a Sump for", async () => {
    const reply = await handleSumpRequest({ method: "GET", path: "/" }, () => undefined);
    expect(reply).toMatchObject({ ok: false, error: { kind: "refused" } });
  });
});
