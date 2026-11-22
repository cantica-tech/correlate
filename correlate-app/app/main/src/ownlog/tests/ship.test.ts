import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readZip } from "../../analysis/zip.js";
import { SumpHttpError } from "../../sump/errors.js";
import { fetchSumpLog, type ShipDeps, shipLogs, shipName, sumpLogName } from "../ship.js";

// REQ-000049-sJpO9KMY, br-DIAG-000002-sJpO9KMY: Ship Logs.

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ship-test-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const NOW = new Date(Date.UTC(2026, 10, 22, 19, 30, 0));

function deps(over: Partial<ShipDeps> = {}) {
  const written = new Map<string, Buffer>();
  const asked: string[] = [];
  const order: string[] = [];
  const d: ShipDeps = {
    dir: () => path.join(root, "logs"),
    current: () => null,
    sumpLog: async () => {
      order.push("sump");
      return { name: "local.log", text: "INFO:correlate_sump.app:ready\n" };
    },
    askSave: async (name) => {
      order.push("ask");
      asked.push(name);
      return path.join(root, "out.zip");
    },
    confirmErase: async () => false,
    write: (file, bytes) => void written.set(file, bytes),
    now: () => NOW,
    ...over,
  };
  return { d, written, asked, order };
}

function logs(...names: string[]): string[] {
  const dir = path.join(root, "logs");
  mkdirSync(dir, { recursive: true });
  for (const n of names) writeFileSync(path.join(dir, n), `log ${n}`);
  writeFileSync(path.join(dir, "notes.txt"), "not a log");
  return names.map((n) => path.join(dir, n));
}

const zipped = (b: Buffer | undefined) => [...readZip(b as Buffer).keys()].sort();

describe("br-DIAG-000002-sJpO9KMY: Ship Logs", () => {
  it("asks where first, then zips every local log file with the Sump's", async () => {
    logs("correlate-a.log", "correlate-b.log");
    const s = deps();
    const r = await shipLogs(s.d);
    expect(s.order).toEqual(["ask", "sump"]);
    expect(s.asked).toEqual(["correlate-logs-2026-11-22-19-30-00.zip"]);
    expect(r).toEqual({ ok: true, file: path.join(root, "out.zip"), local: 2, erased: 0 });
    expect(zipped(s.written.get(path.join(root, "out.zip")))).toEqual([
      "correlate-a.log",
      "correlate-b.log",
      "local.log",
    ]);
  });

  it("ships the Sump's log alone when the folder was never set or is gone (cttc bug 33)", async () => {
    for (const dir of [null, path.join(root, "gone")]) {
      const s = deps({ dir: () => dir });
      const r = await shipLogs(s.d);
      expect(r).toMatchObject({ ok: true, local: 0 });
      expect(zipped(s.written.get(path.join(root, "out.zip")))).toEqual(["local.log"]);
    }
  });

  it("writes nothing when cancelled", async () => {
    const s = deps({ askSave: async () => null });
    expect(await shipLogs(s.d)).toEqual({ ok: false, cancelled: true });
    expect(s.written.size).toBe(0);
  });

  it("erases the shipped local files only on a yes, keeping this run's", async () => {
    const [a, b] = logs("correlate-a.log", "correlate-b.log");
    const kept = deps({ current: () => b ?? null });
    expect(await shipLogs(kept.d)).toMatchObject({ erased: 0 });
    expect(existsSync(a as string)).toBe(true);
    let asked = 0;
    const yes = deps({
      current: () => b ?? null,
      confirmErase: async (n) => {
        asked = n;
        return true;
      },
    });
    expect(await shipLogs(yes.d)).toMatchObject({ erased: 1 });
    expect(asked).toBe(1);
    expect(existsSync(a as string)).toBe(false);
    expect(existsSync(b as string)).toBe(true);
    expect(existsSync(path.join(root, "logs", "notes.txt"))).toBe(true);
  });

  it("names the zip and the Sump's file", () => {
    expect(shipName(NOW)).toBe("correlate-logs-2026-11-22-19-30-00.zip");
    expect(sumpLogName("lab sump/2")).toBe("lab-sump-2.log");
  });
});

describe("REQ-000049-sJpO9KMY: the Sump's part", () => {
  const sump = { name: "lab", baseUrl: "http://lab" };

  it("is the Sump's log, or why it is not there", async () => {
    const got = await fetchSumpLog(sump, async (_s, p, on) => {
      expect(p).toBe("/logs/sump");
      on(new TextEncoder().encode("line\n"));
    });
    expect(got).toEqual({ name: "lab.log", text: "line\n" });
    const notOwner = await fetchSumpLog(sump, async () => {
      throw new SumpHttpError("lab", "GET", "/logs/sump", 403, "only the owner");
    });
    expect(notOwner.text).toBe("Not shipped: only the Sump's owner can ship its log.\n");
    const down = await fetchSumpLog(sump, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(down.text).toBe("Could not reach the Sump: ECONNREFUSED\n");
    expect((await fetchSumpLog(undefined, async () => {})).name).toBe("sump.log");
  });
});
