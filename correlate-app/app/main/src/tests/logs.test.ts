import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXPORT_PAGE,
  exportLog,
  exportName,
  LOGS_EXPORT_CHANNEL,
  LOGS_PREFS_CHANNEL,
  LOGS_SET_PREFS_CHANNEL,
  logPrefs,
  registerLogsIpc,
  setLogPrefs,
} from "../logs.js";
import { Settings } from "../theme.js";

// REQ-000029-sJpO9KMY Requirements 2-4: the panels' choices and Export .log.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "logs-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const quiet = { warn: () => {} };
const settings = () => new Settings(path.join(dir, "settings.json"), quiet);
const event = { sender: { id: 1 } };
const ask = {
  source: "self/web",
  name: "web",
  from: "2026-11-21T18:00:00Z",
  to: "2026-11-21T18:10:00Z",
  order: "oldest",
};

/** A Sump holding `n` rows, counting its calls. */
function sump(n: number) {
  const calls: Record<string, string | number>[] = [];
  const request = async (_e: unknown, m: { query: Record<string, string | number> }) => {
    calls.push(m.query);
    const offset = Number(m.query.offset);
    const rows = Array.from({ length: Math.max(0, Math.min(EXPORT_PAGE, n - offset)) }, (_, i) => ({
      ts: `2026-11-21T18:00:0${(offset + i) % 10}Z`,
      text: `line ${offset + i}`,
    }));
    return { ok: true as const, value: { total: n, offset, rows } };
  };
  return { calls, request };
}

describe("REQ-000029-sJpO9KMY: the panels' choices", () => {
  it("are newest first and lanes folded until changed, then kept across restarts", () => {
    expect(logPrefs(settings())).toEqual({ order: "newest", lanesOpen: false });
    setLogPrefs(settings(), { order: "oldest" });
    setLogPrefs(settings(), { lanesOpen: true });
    expect(logPrefs(settings())).toEqual({ order: "oldest", lanesOpen: true });
  });

  it("refuse anything else", () => {
    expect(() => setLogPrefs(settings(), { order: "sideways" })).toThrow();
    expect(() => setLogPrefs(settings(), { theme: "dark" })).toThrow();
  });
});

describe("br-LOGV-000001-sJpO9KMY: Export .log", () => {
  it("fetches nothing when the save dialog is cancelled", async () => {
    const s = sump(10);
    const r = await exportLog(event, ask, { ask: async () => null, request: s.request });
    expect(r).toEqual({ ok: false, cancelled: true });
    expect(s.calls).toEqual([]);
  });

  it("asks for the file first, then writes every row page by page, owner-only", async () => {
    const s = sump(EXPORT_PAGE + 5);
    const order: string[] = [];
    const file = path.join(dir, "web.log");
    const r = await exportLog(event, ask, {
      ask: async (_e, name) => {
        order.push(`ask ${name}`);
        return file;
      },
      request: async (e, m) => {
        order.push("fetch");
        return s.request(e, m);
      },
      now: () => new Date("2026-11-21T18:12:13Z"),
    });
    expect(r).toEqual({ ok: true, path: file, rows: EXPORT_PAGE + 5 });
    expect(order).toEqual(["ask web-2026-11-21-18-12-13.log", "fetch", "fetch"]);
    expect(s.calls.map((q) => q.offset)).toEqual([0, EXPORT_PAGE]);
    expect(s.calls[0]).toMatchObject({ source: "self/web", order: "oldest", limit: EXPORT_PAGE });
    const lines = readFileSync(file, "utf8").split("\n");
    expect(lines[0]).toBe("2026-11-21T18:00:00Z line 0");
    expect(lines).toHaveLength(EXPORT_PAGE + 6);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses a bad request before asking, and says a failed read", async () => {
    let asked = false;
    const deps = {
      ask: async () => {
        asked = true;
        return path.join(dir, "x.log");
      },
      request: async () => ({ ok: false as const, error: { message: "unreachable" } }),
    };
    expect((await exportLog(event, { ...ask, source: "a b" }, deps)).ok).toBe(false);
    expect(asked).toBe(false);
    const r = await exportLog(event, ask, deps);
    expect(r).toEqual({ ok: false, message: "could not read the logs: unreachable" });
  });

  it("names the file after the container, safely", () => {
    expect(exportName("a/../b c", new Date("2026-01-02T03:04:05Z"))).toBe(
      "a_.._b_c-2026-01-02-03-04-05.log",
    );
  });

  it("answers its three channels", async () => {
    const handlers = new Map<string, (e: { sender: { id: number } }, m: unknown) => unknown>();
    registerLogsIpc({ handle: (c, l) => void handlers.set(c, l) }, settings(), {
      ask: async () => null,
      request: sump(0).request,
    });
    expect(await handlers.get(LOGS_PREFS_CHANNEL)?.(event, undefined)).toEqual({
      order: "newest",
      lanesOpen: false,
    });
    expect(await handlers.get(LOGS_SET_PREFS_CHANNEL)?.(event, { order: 3 })).toMatchObject({
      ok: false,
    });
    expect(await handlers.get(LOGS_EXPORT_CHANNEL)?.(event, ask)).toEqual({
      ok: false,
      cancelled: true,
    });
  });
});
