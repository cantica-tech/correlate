import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { answer } from "../answers.js";
import { manifestHash, readCttcArchive } from "../archive.js";
import {
  ANALYSIS_CLOSE_CHANNEL,
  ANALYSIS_LIST_CHANNEL,
  ANALYSIS_OPEN_CHANNEL,
  ANALYSIS_REMOVE_CHANNEL,
  ANALYSIS_REQUEST_CHANNEL,
  ANALYSIS_SWITCH_CHANNEL,
  fileRequest,
  OpenFiles,
  openFiles,
  registerAnalysisIpc,
} from "../ipc.js";
import { readZip } from "../zip.js";
import { zip } from "./zipWriter.js";

// REQ-000033-sJpO9KMY Requirements 1-3: cttc's files read-only, and their
// answers to the views, for the calling window only.

/** A path as the OS resolves it (a drive and backslashes on Windows). */
const resolved = (p: string) => path.resolve(p);
const here = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.UTC(2026, 7, 6, 12, 0, 0);

/** A cttc archive of two segments: two containers' stats, the host's, one container's logs. */
function archive(): Buffer {
  const segment = (n: number, from: number) => ({
    from,
    to: from + 60_000,
    created: "2026-08-06T12:00:00.000Z",
    sources: [
      { type: "stats", name: "stats@local", file: `seg${n}/stats/0.json`, is_host: false },
      {
        type: "stats",
        name: "host@local",
        file: `seg${n}/stats/1.json`,
        is_host: true,
        docker_host_id: "local",
      },
      { type: "log", name: "web", file: `seg${n}/logs/2.jsonl`, count: 3 },
    ],
  });
  const manifest = { version: 3, segments: [segment(0, T0), segment(1, T0 + 120_000)] };
  const stats = (from: number) =>
    JSON.stringify({
      series: {
        web: [
          [from + 1000, 12.5, 40, 1000, 2000],
          [from + 6000, 50, 41, 1100, 4000],
        ],
        db: [[from + 1000, 3, 10, 500, 100]],
      },
    });
  const host = (from: number) =>
    JSON.stringify({ series: { "host@local": [[from + 1000, 26.4, 67.9, 1.1e10, 256981]] } });
  const logs = (from: number) =>
    [
      { ts: from + 500, text: "GET / 200" },
      { ts: from + 500, text: "ERROR db timed out" },
      { ts: from + 9000, text: "GET /health 200" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
  return zip({
    "seg0/stats/0.json": stats(T0),
    "seg0/stats/1.json": host(T0),
    "seg0/logs/2.jsonl": logs(T0),
    "seg1/stats/0.json": stats(T0 + 120_000),
    "seg1/stats/1.json": host(T0 + 120_000),
    "seg1/logs/2.jsonl": logs(T0 + 120_000),
    "manifest.json": JSON.stringify(manifest),
  });
}

const iso = (t: number) => new Date(t).toISOString();
const span = { from: iso(T0), to: iso(T0 + 180_000) };

describe("REQ-000033-sJpO9KMY: reading cttc's files", () => {
  it("reads every segment: containers, the host and logs, oldest first", () => {
    const file = readCttcArchive(archive(), resolved("/data/run.cttc-record"));
    expect(file.label).toBe("run.cttc-record");
    expect([file.from, file.to]).toEqual([T0, T0 + 180_000]);
    expect(file.containers).toEqual(["db", "web"]);
    expect(file.stats.get("web")?.map((r) => r[1])).toEqual([12.5, 50, 12.5, 50]);
    expect(file.host).toHaveLength(2);
    expect(file.hostName).toBe("localhost");
    expect(file.logs.get("web")?.map((r) => r.text)).toEqual([
      "GET / 200",
      "ERROR db timed out",
      "GET /health 200",
      "GET / 200",
      "ERROR db timed out",
      "GET /health 200",
    ]);
  });

  it("checks the manifest's hash as cttc wrote it, numbers as written", () => {
    // cttc-manifest.json is a real cttc manifest, byte for byte (kept out of the formatter).
    const text = readFileSync(path.join(here, "cttc-manifest.json"), "utf8");
    const written = (JSON.parse(text) as { integrity_sha256: string }).integrity_sha256;
    expect(manifestHash(text)).toBe(written);
    // A changed manifest is read, with a warning.
    const changed = text.replace(/"count":\s*450/, '"count":451');
    expect(changed).not.toBe(text);
    expect(manifestHash(changed)).not.toBe(written);
  });

  it.each([
    ["not a zip", Buffer.from("hello"), "not a zip"],
    ["no manifest", zip({ "a.txt": "x" }), "no manifest.json"],
    ["another version", zip({ "manifest.json": '{"version":2,"segments":[]}' }), "version 2"],
    ["no time range", zip({ "manifest.json": '{"version":3,"segments":[]}' }), "no time range"],
  ])("refuses %s", (_what, bytes, why) => {
    expect(() => readCttcArchive(bytes, "x.cttc-record")).toThrow(why);
  });

  it("refuses a zip past its limits before inflating", () => {
    const big = zip({ "a.txt": "x".repeat(1000), "b.txt": "y" });
    expect(() => readZip(big, { entries: 1, bytes: 1e6 })).toThrow("more than 1 entries");
    expect(() => readZip(big, { entries: 10, bytes: 100 })).toThrow("more than 100 bytes");
    expect(
      readZip(zip({ "s.txt": "stored" }, true))
        .get("s.txt")
        ?.toString(),
    ).toBe("stored");
  });
});

describe("br-ANLYS-000001-sJpO9KMY: the file answers the views", () => {
  const file = readCttcArchive(archive(), resolved("/data/run.cttc-record"));
  const get = (p: string, query: Record<string, string | number> = {}) =>
    answer(file, { method: "GET", path: p, query });

  it("is one stream following its containers, its host named", () => {
    expect(get("/streams")).toEqual({
      ok: true,
      value: {
        streams: [
          {
            id: "file",
            kind: "file",
            label: "run.cttc-record",
            host: "localhost",
            paused: false,
            following: 2,
            followed: { containers: ["db", "web"], services: [] },
          },
        ],
      },
    });
    expect(get("/records/range", { sources: "file/web,file/__host__" })).toEqual({
      ok: true,
      value: span,
    });
  });

  it("answers the strips: each bucket's maximum of the matching column", () => {
    const q = { ...span, source: "file/web", buckets: 3 };
    expect(get("/records/buckets", { ...q, field: "cpu_percent", mode: "max" })).toEqual({
      ok: true,
      value: { values: [50, null, 50] },
    });
    expect(
      get("/records/buckets", { ...q, field: "mem_used_bytes", over: "mem_limit_bytes" }),
    ).toEqual({ ok: true, value: { values: [41, null, 41] } });
    expect(
      get("/records/buckets", { ...q, field: "net_rx_bytes,net_tx_bytes", mode: "rate" }),
    ).toEqual({ ok: true, value: { values: [4000, null, 4000] } });
    const host = get("/records/buckets", { ...q, source: "file/__host__", field: "cpu_percent" });
    expect(host).toEqual({ ok: true, value: { values: [26.4, null, 26.4] } });
  });

  it("pages, finds, places and counts the logs as the Sump does", () => {
    const q = { ...span, source: "file/web" };
    const page = get("/records/logs", { ...q, offset: 0, limit: 2 });
    expect(page).toEqual({
      ok: true,
      value: {
        total: 6,
        offset: 0,
        rows: [
          { ts: iso(T0 + 129_000), text: "GET /health 200" },
          { ts: iso(T0 + 120_500), text: "ERROR db timed out" },
        ],
      },
    });
    expect(get("/records/logs/find", { ...q, q: "error", from_index: 1 })).toEqual({
      ok: true,
      value: { index: 4, total: 6 },
    });
    expect(get("/records/logs/at", { ...q, order: "oldest", t: iso(T0 + 8000) })).toEqual({
      ok: true,
      value: { index: 2, total: 6 },
    });
    const density = get("/records/density", { ...q, buckets: 3 });
    expect(density).toEqual({ ok: true, value: { buckets: 3, counts: [3, 0, 3], total: 6 } });
  });

  it("refuses what it cannot answer: writes, other paths, other sources, bad queries", () => {
    expect(answer(file, { method: "PUT", path: "/streams" })).toMatchObject({ ok: false });
    expect(get("/streams/self/targets")).toMatchObject({ ok: false, error: { status: 404 } });
    expect(get("/records/logs", { ...span, source: "self/web" })).toMatchObject({
      ok: false,
      error: { status: 422 },
    });
    expect(get("/records/logs", { source: "file/web", from: "x", to: "y" })).toMatchObject({
      ok: false,
    });
  });
});

describe("REQ-000034-sJpO9KMY: a window's open files", () => {
  const event = { sender: { id: 1 } };
  /** Deps choosing `chosen`, each read as `bytes` (or per path). */
  const deps = (chosen: string[], bytes: Record<string, Buffer> | Buffer = archive()) => ({
    ask: async () => chosen,
    size: async () => 1000,
    read: async (f: string) => (Buffer.isBuffer(bytes) ? bytes : (bytes[f] ?? archive())),
  });

  it("asks first; cancelling reads nothing; files are kept for their window only", async () => {
    const files = new OpenFiles();
    let read = false;
    const cancelled = await openFiles(event, files, {
      ...deps([]),
      read: async () => {
        read = true;
        return archive();
      },
    });
    expect(cancelled).toEqual({ ok: false, cancelled: true });
    expect(read).toBe(false);
    const opened = await openFiles(event, files, deps([resolved("/data/run.cttc-record")]));
    expect(opened).toMatchObject({
      ok: true,
      active: resolved("/data/run.cttc-record"),
      files: [{ path: resolved("/data/run.cttc-record"), label: "run.cttc-record", from: T0 }],
      refused: [],
    });
    expect(fileRequest(files, 1, { method: "GET", path: "/streams" }).ok).toBe(true);
    expect(fileRequest(files, 2, { method: "GET", path: "/streams" })).toMatchObject({
      ok: false,
      error: { status: 409 },
    });
  });

  it("opens several, the last active; refuses one it cannot read or without data", async () => {
    const files = new OpenFiles();
    const empty = zip({
      "manifest.json": JSON.stringify({
        version: 3,
        segments: [{ from: T0, to: T0 + 1000, sources: [] }],
      }),
    });
    const r = await openFiles(
      event,
      files,
      deps(
        [
          resolved("/a/one.cttc-record"),
          resolved("/a/bad.cttc-record"),
          resolved("/a/empty.cttc-metric"),
          resolved("/a/two.cttc-record"),
        ],
        {
          [resolved("/a/bad.cttc-record")]: Buffer.from("no"),
          [resolved("/a/empty.cttc-metric")]: empty,
        },
      ),
    );
    expect(r).toMatchObject({ ok: true, active: resolved("/a/two.cttc-record") });
    if (!r.ok) return;
    expect(r.files.map((f) => f.path)).toEqual([
      resolved("/a/one.cttc-record"),
      resolved("/a/two.cttc-record"),
    ]);
    expect(r.refused).toEqual([
      expect.stringContaining("bad.cttc-record: not a zip"),
      expect.stringContaining("empty.cttc-metric: it holds no data"),
    ]);
    const none = await openFiles(
      event,
      new OpenFiles(),
      deps([resolved("/a/bad")], Buffer.from("x")),
    );
    expect(none).toMatchObject({ ok: false, refused: [expect.stringContaining("not a zip")] });
  });

  it("switches, removes falling back to the last opened left, then live; live keeps the files", () => {
    const files = new OpenFiles();
    for (const name of ["a", "b", "c"]) {
      files.set(1, readCttcArchive(archive(), `/d/${name}.cttc-record`));
    }
    expect(files.switchTo(1, resolved("/d/a.cttc-record"))).toBe(true);
    expect(files.switchTo(1, resolved("/d/zzz.cttc-record"))).toBe(false);
    files.remove(1, resolved("/d/a.cttc-record"));
    expect(files.list(1).active).toBe("/d/c.cttc-record");
    files.leave(1);
    expect(files.list(1)).toMatchObject({ active: null });
    expect(files.list(1).files).toHaveLength(2);
    expect(files.get(1)).toBeUndefined();
    files.remove(1, resolved("/d/b.cttc-record"));
    expect(files.list(1).active).toBeNull();
    files.switchTo(1, resolved("/d/c.cttc-record"));
    files.remove(1, resolved("/d/c.cttc-record"));
    expect(files.list(1)).toEqual({ files: [], active: null });
  });

  it("answers its channels", async () => {
    const files = new OpenFiles();
    const handlers = new Map<string, (e: object, m?: unknown) => unknown>();
    registerAnalysisIpc(
      { handle: (c, l) => void handlers.set(c, l) },
      files,
      deps([resolved("/d/r.cttc-record"), resolved("/d/s.cttc-record")]),
    );
    expect(await handlers.get(ANALYSIS_OPEN_CHANNEL)?.(event)).toMatchObject({ ok: true });
    expect(
      await handlers.get(ANALYSIS_REQUEST_CHANNEL)?.(event, { method: "GET", path: "/streams" }),
    ).toMatchObject({ ok: true });
    expect(await handlers.get(ANALYSIS_LIST_CHANNEL)?.(event)).toMatchObject({
      active: resolved("/d/s.cttc-record"),
    });
    expect(
      await handlers.get(ANALYSIS_SWITCH_CHANNEL)?.(event, resolved("/d/r.cttc-record")),
    ).toMatchObject({
      ok: true,
      active: resolved("/d/r.cttc-record"),
    });
    expect(
      await handlers.get(ANALYSIS_REMOVE_CHANNEL)?.(event, resolved("/d/r.cttc-record")),
    ).toMatchObject({
      active: resolved("/d/s.cttc-record"),
    });
    expect(await handlers.get(ANALYSIS_CLOSE_CHANNEL)?.(event)).toEqual({ ok: true });
    expect(files.get(1)).toBeUndefined();
    expect(files.list(1).files).toHaveLength(1);
  });
});
