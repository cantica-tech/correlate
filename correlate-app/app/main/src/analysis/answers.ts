/**
 * A file's answers to the views (REQ-000033-sJpO9KMY Requirement 2,
 * br-ANLYS-000001-sJpO9KMY): the same routes and shapes the views ask a
 * Sump for, answered from a file read by `archive.ts`, so the charts, lanes
 * and log panels show it unchanged and nothing of it reaches a Sump.
 *
 * The file is one stream, `file`, following its containers; its host's
 * records are `file/__host__`, as the Sump names a stream's host. cttc's
 * stats rows already hold the memory percentage and the network rate, so the
 * strips' fields map onto them: CPU % onto cpu %, memory used over its limit
 * onto mem %, the network counters' rate onto bytes/s.
 */
import type { FileData, LogRow, StatsRow } from "./archive.js";

/** The file's stream id. */
export const FILE_STREAM = "file";
/** The host's name within a stream, as the Sump's. */
export const HOST_NAME = "__host__";

/** A request, as the views make it of the Sump bridge. */
export interface FileRequest {
  method?: string;
  path?: string;
  query?: Record<string, string | number | boolean>;
}

/** The bridge's answer shape. */
export type FileAnswer =
  | { ok: true; value: unknown }
  | { ok: false; error: { kind: "http"; message: string; status: number; detail: unknown } };

const refuse = (status: number, message: string): FileAnswer => ({
  ok: false,
  error: { kind: "http", message, status, detail: message },
});

/** Answer `request` from `file`; never throws. */
export function answer(file: FileData, request: FileRequest): FileAnswer {
  if (request.method !== "GET") return refuse(405, "a file is only read");
  const q = request.query ?? {};
  try {
    switch (request.path) {
      case "/streams":
        return { ok: true, value: { streams: [streamOf(file)] } };
      case "/records/range":
        return { ok: true, value: rangeOf(file, String(q.sources ?? "")) };
      case "/records/buckets":
        return { ok: true, value: { values: buckets(file, q) } };
      case "/records/logs":
        return { ok: true, value: logPage(file, q) };
      case "/records/logs/find":
        return { ok: true, value: findRow(file, q) };
      case "/records/logs/at":
        return { ok: true, value: nearestRow(file, q) };
      case "/records/density":
        return { ok: true, value: density(file, q) };
      default:
        return refuse(404, `a file does not answer ${request.path}`);
    }
  } catch (error) {
    return refuse(422, (error as Error).message);
  }
}

/** The file as the views' one stream. */
function streamOf(file: FileData) {
  return {
    id: FILE_STREAM,
    kind: "file",
    label: file.label,
    host: file.hostName,
    paused: false,
    following: file.containers.length,
    followed: { containers: file.containers, services: [] },
  };
}

/** A source's name within the file, or throws. */
function nameOf(source: unknown): string {
  const text = String(source ?? "");
  if (!text.startsWith(`${FILE_STREAM}/`)) throw new Error(`no source ${text} in this file`);
  return text.slice(FILE_STREAM.length + 1);
}

/** `from`, `to` (ISO), checked. */
function rangeQuery(q: Record<string, unknown>): { t0: number; t1: number } {
  const t0 = Date.parse(String(q.from));
  const t1 = Date.parse(String(q.to));
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) throw new Error("from and to are times");
  if (t1 <= t0) throw new Error("to must be after from");
  return { t0, t1 };
}

/** A whole number in `[lo, hi]`, or throws. */
function whole(value: unknown, lo: number, hi: number, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${what} must be ${lo} to ${hi}`);
  return n;
}

/** The earliest and latest record of the sources asked: the file's own range. */
function rangeOf(file: FileData, sources: string): { from: string | null; to: string | null } {
  const names = sources.split(",").filter(Boolean);
  if (names.length === 0) throw new Error("sources are 1 or more");
  for (const n of names) nameOf(n);
  return { from: new Date(file.from).toISOString(), to: new Date(file.to).toISOString() };
}

/** The column of a stats row the strip's fields map onto. */
function columnOf(fields: string, over: unknown): number {
  if (fields.includes("cpu_percent")) return 1;
  if (fields.includes("mem_used_bytes")) return over ? 2 : 3;
  if (fields.includes("net_")) return 4;
  throw new Error(`a file has no field ${fields}`);
}

/** Each bucket's maximum of the strip's column over the view, or null when empty. */
function buckets(file: FileData, q: Record<string, unknown>): (number | null)[] {
  const name = nameOf(q.source);
  const { t0, t1 } = rangeQuery(q);
  const n = whole(q.buckets, 1, 2000, "buckets");
  const column = columnOf(String(q.field ?? ""), q.over);
  const rows: StatsRow[] = name === HOST_NAME ? file.host : (file.stats.get(name) ?? []);
  const values: (number | null)[] = new Array(n).fill(null);
  const span = t1 - t0;
  for (const row of rows) {
    const t = row[0];
    const v = row[column];
    if (t < t0 || t > t1 || v === null || v === undefined) continue;
    const b = Math.min(n - 1, Math.floor(((t - t0) / span) * n));
    const current = values[b];
    if (current === null || current === undefined || v > current) values[b] = v;
  }
  return values;
}

/** A container's log rows over the view, in order: ties keep the file's order. */
function rows(file: FileData, q: Record<string, unknown>): LogRow[] {
  const name = nameOf(q.source);
  const { t0, t1 } = rangeQuery(q);
  const order = q.order ?? "newest";
  if (order !== "newest" && order !== "oldest") throw new Error("order is newest or oldest");
  const inRange = (file.logs.get(name) ?? []).filter((r) => r.ts >= t0 && r.ts <= t1);
  return order === "newest" ? inRange.reverse() : inRange;
}

/** A row as the Sump gives it. */
const shown = (r: LogRow) => ({ ts: new Date(r.ts).toISOString(), text: r.text });

function logPage(file: FileData, q: Record<string, unknown>) {
  const all = rows(file, q);
  const offset = whole(q.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, "offset");
  const limit = whole(q.limit ?? 200, 1, 1000, "limit");
  return { total: all.length, offset, rows: all.slice(offset, offset + limit).map(shown) };
}

function findRow(file: FileData, q: Record<string, unknown>) {
  const all = rows(file, q);
  const needle = String(q.q ?? "").toLowerCase();
  if (!needle || needle.length > 200) throw new Error("q is 1 to 200 characters");
  const from = Number(q.from_index ?? -1);
  const next = (q.direction ?? "next") === "next";
  if (!next && q.direction !== "previous") throw new Error("direction is next or previous");
  if (next) {
    for (let i = Math.max(-1, from) + 1; i < all.length; i++) {
      if (all[i]?.text.toLowerCase().includes(needle)) return { index: i, total: all.length };
    }
  } else {
    for (let i = Math.min(from, all.length) - 1; i >= 0; i--) {
      if (all[i]?.text.toLowerCase().includes(needle)) return { index: i, total: all.length };
    }
  }
  return { index: null, total: all.length };
}

function nearestRow(file: FileData, q: Record<string, unknown>) {
  const all = rows(file, q);
  const t = Date.parse(String(q.t));
  if (!Number.isFinite(t)) throw new Error("t is a time");
  let best: number | null = null;
  let gap = 0;
  all.forEach((r, i) => {
    const g = Math.abs(r.ts - t);
    if (best === null || g < gap) {
      best = i;
      gap = g;
    }
  });
  return { index: best, total: all.length };
}

function density(file: FileData, q: Record<string, unknown>) {
  const all = rows(file, { ...q, order: "oldest" });
  const { t0, t1 } = rangeQuery(q);
  const n = whole(q.buckets ?? 500, 1, 2000, "buckets");
  const counts = new Array<number>(n).fill(0);
  for (const r of all) {
    const b = Math.min(n - 1, Math.floor(((r.ts - t0) / (t1 - t0)) * n));
    counts[b] = (counts[b] ?? 0) + 1;
  }
  return { buckets: n, counts, total: all.length };
}
