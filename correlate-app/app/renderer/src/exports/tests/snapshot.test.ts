/**
 * Snapshots (REQ-000041-sJpO9KMY Requirement 3, br-EXPORT-000004-sJpO9KMY):
 * each value its last sample within 15 s, the host first, the log lines
 * around the time, a panorama, cttc's text.
 */
import { describe, expect, it } from "vitest";
import type { SumpRequester } from "../../shell/bridge.js";
import {
  fmtBytes,
  lastSample,
  type SnapshotScope,
  snapshotName,
  snapshotToText,
  takeSnapshot,
} from "../snapshot.js";

const T = Date.UTC(2026, 10, 22, 12, 0, 30);

/** A Sump (or file) answering buckets by source and field, and web's logs. */
function fake(values: Record<string, (number | null)[]>) {
  const asked: { path: string; query: Record<string, string | number | boolean> }[] = [];
  const request: SumpRequester = async ({ path, query = {} }) => {
    asked.push({ path, query });
    if (path === "/records/buckets")
      return { ok: true, value: { values: values[`${query.source}:${query.field}`] ?? [] } };
    if (path === "/records/logs/at") return { ok: true, value: { index: 5 } };
    if (path === "/records/logs") {
      const offset = Number(query.offset);
      const rows = Array.from({ length: Number(query.limit) }, (_, i) => ({
        ts: new Date(T + (offset + i - 5) * 1000).toISOString(),
        text: `line ${offset + i}\nsecond line`,
      }));
      return { ok: true, value: { rows, total: 20 } };
    }
    return { ok: false, error: { kind: "http", message: "no", status: 404, detail: "no" } };
  };
  return { request, asked };
}

/** 15 buckets of one second; `at` the bucket index with the value, the rest empty. */
const one = (v: number, at: number) => Array.from({ length: 15 }, (_, i) => (i === at ? v : null));

const scope = (request: SumpRequester, host = true): SnapshotScope => ({
  request,
  stream: "self",
  containers: ["web", "api"],
  host: host ? { label: "localhost" } : null,
  view: { t0: T - 60_000, t1: T + 60_000 },
});

const off = {
  includeLogs: false,
  panoramaOn: false,
  panoramaUnit: "entries" as const,
  panoramaValue: 3,
};

describe("br-EXPORT-000004-sJpO9KMY: a snapshot's values", () => {
  it("takes each value's last sample in the 15 s before the time, the host first", async () => {
    const f = fake({
      "self/web:cpu_percent": one(12.34, 13),
      "self/web:mem_used_bytes": one(50, 2),
      "self/web:net_rx_bytes,net_tx_bytes": one(2500, 14),
      "self/__host__:cpu_percent": one(80, 14),
    });
    const snap = await takeSnapshot(scope(f.request), T, off, () => new Date(T));
    expect(snap.slices).toHaveLength(1);
    const [host, api, web] = snap.slices[0].services;
    expect(host).toEqual({ name: "localhost", host: true, cpu: 80, mem: null, net: null, ts: T });
    expect(api).toMatchObject({ name: "api", cpu: null, mem: null, net: null, ts: null });
    expect(web).toEqual({ name: "web", host: false, cpu: 12.34, mem: 50, net: 2500, ts: T });
    // Asked over the 15 s before the time, one bucket a second, as the strips ask.
    const q = f.asked.find((a) => a.query.source === "self/web" && a.query.field === "cpu_percent");
    expect(q?.query).toMatchObject({
      from: new Date(T - 15_000).toISOString(),
      to: new Date(T).toISOString(),
      buckets: 15,
      mode: "max",
    });
  });

  it("leaves the host out when its block is not shown", async () => {
    const f = fake({});
    const snap = await takeSnapshot(scope(f.request, false), T, off);
    expect(snap.slices[0].services.map((s) => s.name)).toEqual(["api", "web"]);
    expect(f.asked.some((a) => String(a.query.source).endsWith("__host__"))).toBe(false);
  });

  it("finds the last non-empty bucket and its end", () => {
    expect(lastSample([1, null, 3, null], 0, 4000)).toEqual({ v: 3, ts: 3000 });
    expect(lastSample([null, null], 0, 2000)).toBeNull();
  });
});

describe("br-EXPORT-000004-sJpO9KMY: log lines and panorama", () => {
  it("takes the nearest line alone, or with N entries each side", async () => {
    const f = fake({});
    const plain = await takeSnapshot(scope(f.request), T, { ...off, includeLogs: true });
    expect(plain.slices[0].logs.map((l) => [l.source, l.rows.map((r) => r.text)])).toEqual([
      ["web", ["line 5\nsecond line"]],
      ["api", ["line 5\nsecond line"]],
    ]);
    const wide = await takeSnapshot(scope(f.request), T, {
      includeLogs: true,
      panoramaOn: true,
      panoramaUnit: "entries",
      panoramaValue: 2,
    });
    expect(wide.slices[0].logs[0].rows.map((r) => r.text.split("\n")[0])).toEqual([
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
    ]);
  });

  it("adds a slice N seconds before and after, widening where logs are looked for", async () => {
    const f = fake({});
    const s = scope(f.request);
    const snap = await takeSnapshot({ ...s, view: { t0: T - 1000, t1: T + 1000 } }, T, {
      includeLogs: true,
      panoramaOn: true,
      panoramaUnit: "seconds",
      panoramaValue: 10,
    });
    expect(snap.slices.map((sl) => [sl.label, sl.t - T])).toEqual([
      ["10s before", -10_000],
      ["at", 0],
      ["10s after", 10_000],
    ]);
    const at = f.asked.find((a) => a.path === "/records/logs/at");
    expect(at?.query).toMatchObject({
      from: new Date(T - 10_000).toISOString(),
      to: new Date(T + 10_000).toISOString(),
    });
  });
});

describe("cttc's snapshot text", () => {
  it("writes the table and the lines as cttc's Save as TXT", async () => {
    const f = fake({ "self/web:cpu_percent": one(12.34, 14) });
    const snap = await takeSnapshot(
      { ...scope(f.request, false), containers: ["web"] },
      T,
      { ...off, includeLogs: true },
      () => new Date(T),
    );
    const text = snapshotToText(snap).split("\n");
    expect(text.slice(0, 2)).toEqual([
      "Snapshot @ 2026-11-22 12:00:30.000 UTC",
      "Generated: 2026-11-22T12:00:30.000Z",
    ]);
    expect(text[3]).toBe("source  cpu    mem  net  at          ");
    expect(text[4]).toMatch(/^web {5}12\.3% {2}- {4}- {4}\d\d:\d\d:30\.000$/);
    expect(text[6]).toBe("[web]");
    expect(text[7]).toMatch(/^ {2}\d\d:\d\d:30\.000 {2}line 5$/);
  });

  it("names its files and writes throughput as cttc", () => {
    expect(snapshotName(T, "json")).toBe("snapshot-2026-11-22-12-00-30.json");
    expect([fmtBytes(512), fmtBytes(2500), fmtBytes(3e6), fmtBytes(4e9)]).toEqual([
      "512 B/s",
      "2.5 kB/s",
      "3.0 MB/s",
      "4.0 GB/s",
    ]);
  });
});
