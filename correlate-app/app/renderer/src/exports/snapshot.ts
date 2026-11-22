/**
 * Snapshots (br-EXPORT-000004-sJpO9KMY, cttc's `takeSnapshot`,
 * `computeSlice`, `snapshotToText`, `app.js:1389-1560`; REQ-000041-sJpO9KMY
 * Requirement 3): what the active view shows at one time.
 *
 * Every value is asked through the window's bridge, which answers from the
 * Sump in the live view and from the shown file in the analysis view, so a
 * snapshot holds only the active view's data (br-EXPORT-000001-sJpO9KMY;
 * cttc's BUG-000014 let host rows through from the other view).
 */

import { STRIPS } from "../charts/strips.js";
import type { Viewport } from "../correlate/atoms.js";
import { clock, nearestRow } from "../logs/api.js";
import type { SumpRequester } from "../shell/bridge.js";

/** A container's (or the host's) value is its last sample this long before the time, at most. */
export const VALUE_WINDOW_MS = 15_000;

/** One sample per second over the window: the last non-empty one is the value. */
const VALUE_BUCKETS = 15;

/** What a snapshot is of: the active view's stream, shown containers and host. */
export interface SnapshotScope {
  request: SumpRequester;
  /** The stream's id: sources are `<stream>/<container>`. */
  stream: string;
  containers: readonly string[];
  /** The host's block is shown; its label in the table. */
  host: { label: string } | null;
  /** The time range the logs are looked for in (the view's, widened to the slices). */
  view: Viewport;
}

/** A container's (or the host's) values at a time; null where there is none. */
export interface SnapshotSeries {
  name: string;
  host: boolean;
  cpu: number | null;
  mem: number | null;
  /** Network throughput, bytes per second. */
  net: number | null;
  /** When the latest of these values was sampled. */
  ts: number | null;
}

/** One time's values and log lines. */
export interface SnapshotSlice {
  label: string;
  t: number;
  services: SnapshotSeries[];
  logs: { source: string; rows: { ts: number; text: string }[] }[];
}

/** What the dialog asks for. */
export interface SnapshotOptions {
  includeLogs: boolean;
  panoramaOn: boolean;
  panoramaUnit: "entries" | "seconds";
  panoramaValue: number;
}

/** A snapshot, as cttc's JSON has it. */
export interface Snapshot {
  t: number;
  panoramaOn: boolean;
  panoramaUnit: "entries" | "seconds";
  panoramaValue: number;
  generated_at: string;
  slices: SnapshotSlice[];
}

/** cttc's `fmtBytes`: a throughput. */
export function fmtBytes(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} GB/s`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB/s`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)} kB/s`;
  return `${v.toFixed(0)} B/s`;
}

/** cttc's `fmtIso`: `2026-11-22 14:05:00.000 UTC`. */
export function fmtIso(t: number): string {
  return new Date(t).toISOString().replace("T", " ").replace("Z", " UTC");
}

/** cttc's file name for a snapshot at `t`. */
export function snapshotName(t: number, kind: "txt" | "json"): string {
  return `snapshot-${new Date(t).toISOString().slice(0, 19).replace(/[T:]/g, "-")}.${kind}`;
}

/** The last non-empty bucket of `values` over `t0`..`t1`: its value and its end. */
export function lastSample(
  values: readonly (number | null)[],
  t0: number,
  t1: number,
): { v: number; ts: number } | null {
  const width = (t1 - t0) / Math.max(1, values.length);
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return { v, ts: t0 + (i + 1) * width };
  }
  return null;
}

/** `source`'s CPU, memory and network at `t`: each its last sample within the window. */
async function valuesAt(
  request: SumpRequester,
  source: string,
  t: number,
): Promise<Omit<SnapshotSeries, "name" | "host">> {
  const window = { t0: t - VALUE_WINDOW_MS, t1: t };
  const found = await Promise.all(
    STRIPS.map(async (strip) => {
      const query: Record<string, string | number> = {
        source,
        from: new Date(window.t0).toISOString(),
        to: new Date(window.t1).toISOString(),
        buckets: VALUE_BUCKETS,
        mode: strip.mode,
        field: strip.fields.join(","),
      };
      if (strip.over) query.over = strip.over;
      const reply = await request({ method: "GET", path: "/records/buckets", query });
      if (!reply.ok) return null;
      const values = (reply.value as { values?: (number | null)[] }).values ?? [];
      return lastSample(values, window.t0, window.t1);
    }),
  );
  const [cpu, mem, net] = found;
  const times = found.flatMap((f) => (f ? [f.ts] : []));
  return {
    cpu: cpu?.v ?? null,
    mem: mem?.v ?? null,
    net: net?.v ?? null,
    ts: times.length > 0 ? Math.max(...times) : null,
  };
}

/** `source`'s log lines around `t`: the nearest one and `context` on each side. */
async function linesAt(
  scope: SnapshotScope,
  source: string,
  t: number,
  context: number,
): Promise<{ ts: number; text: string }[]> {
  const near = await nearestRow(scope.request, source, scope.view, "oldest", t);
  if (!near.ok || near.index === null) return [];
  const reply = await scope.request({
    method: "GET",
    path: "/records/logs",
    query: {
      source,
      from: new Date(scope.view.t0).toISOString(),
      to: new Date(scope.view.t1).toISOString(),
      offset: Math.max(0, near.index - context),
      limit: context * 2 + 1,
      order: "oldest",
    },
  });
  if (!reply.ok) return [];
  const rows = (reply.value as { rows?: { ts: string; text: string }[] }).rows ?? [];
  return rows.map((r) => ({ ts: Date.parse(r.ts), text: String(r.text ?? "") }));
}

/** One slice at `t` (cttc's `computeSlice`): the host first, then the containers by name. */
export async function sliceAt(
  scope: SnapshotScope,
  label: string,
  t: number,
  includeLogs: boolean,
  context: number,
): Promise<SnapshotSlice> {
  const named = [...scope.containers].sort((a, b) => a.localeCompare(b));
  const services: SnapshotSeries[] = [];
  if (scope.host) {
    const v = await valuesAt(scope.request, `${scope.stream}/__host__`, t);
    services.push({ name: scope.host.label, host: true, ...v });
  }
  for (const name of named) {
    services.push({
      name,
      host: false,
      ...(await valuesAt(scope.request, `${scope.stream}/${name}`, t)),
    });
  }
  const logs = includeLogs
    ? (
        await Promise.all(
          scope.containers.map(async (name) => ({
            source: name,
            rows: await linesAt(scope, `${scope.stream}/${name}`, t, context),
          })),
        )
      ).filter((l) => l.rows.length > 0)
    : [];
  return { label, t, services, logs };
}

/** A snapshot at `t`: one slice, or with a panorama in seconds, two more around it. */
export async function takeSnapshot(
  scope: SnapshotScope,
  t: number,
  options: SnapshotOptions,
  now: () => Date = () => new Date(),
): Promise<Snapshot> {
  const value = options.panoramaOn ? Math.max(0, Math.floor(options.panoramaValue) || 0) : 0;
  const context = options.panoramaUnit === "entries" ? value : 0;
  const seconds = options.panoramaUnit === "seconds" ? value : 0;
  const wanted =
    seconds > 0
      ? [
          { label: `${seconds}s before`, at: t - seconds * 1000 },
          { label: "at", at: t },
          { label: `${seconds}s after`, at: t + seconds * 1000 },
        ]
      : [{ label: "at", at: t }];
  const view = {
    t0: Math.min(scope.view.t0, t - seconds * 1000),
    t1: Math.max(scope.view.t1, t + seconds * 1000),
  };
  const slices = await Promise.all(
    wanted.map((w) => sliceAt({ ...scope, view }, w.label, w.at, options.includeLogs, context)),
  );
  return {
    t,
    panoramaOn: options.panoramaOn,
    panoramaUnit: options.panoramaUnit,
    panoramaValue: value,
    generated_at: now().toISOString(),
    slices,
  };
}

/** A value as the table shows it, or `missing`. */
export function cell(
  s: SnapshotSeries,
  key: "cpu" | "mem" | "net" | "ts",
  missing: string,
): string {
  const v = s[key];
  if (v === null) return missing;
  if (key === "net") return fmtBytes(v);
  if (key === "ts") return clock(v);
  return `${v.toFixed(1)}%`;
}

/** A panorama in words, or "". */
export function panoramaWords(snap: Snapshot): string {
  if (!(snap.panoramaOn && snap.panoramaValue)) return "";
  return snap.panoramaUnit === "seconds"
    ? `panorama ±${snap.panoramaValue}s`
    : `panorama ${snap.panoramaValue} entries`;
}

/** cttc's `snapshotToText`: the Raw view as plain text, for Save as TXT. */
export function snapshotToText(snap: Snapshot): string {
  const lines = [`Snapshot @ ${fmtIso(snap.t)}`];
  if (snap.panoramaOn && snap.panoramaValue) {
    lines.push(
      snap.panoramaUnit === "seconds"
        ? `Panorama: +/- ${snap.panoramaValue}s`
        : `Panorama: ${snap.panoramaValue} entries`,
    );
  }
  lines.push(`Generated: ${snap.generated_at}`);
  for (const slice of snap.slices) {
    lines.push("");
    if (snap.slices.length > 1) lines.push(`== ${slice.label} — ${fmtIso(slice.t)} ==`);
    if (slice.services.length > 0) {
      const header = ["source", "cpu", "mem", "net", "at"];
      const rows = slice.services.map((s) => [
        (s.host ? "* " : "") + s.name,
        cell(s, "cpu", "-"),
        cell(s, "mem", "-"),
        cell(s, "net", "-"),
        cell(s, "ts", "-"),
      ]);
      const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
      const row = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
      lines.push(row(header));
      for (const r of rows) lines.push(row(r));
    } else {
      lines.push("(no telemetry)");
    }
    for (const l of slice.logs) {
      lines.push("");
      lines.push(`[${l.source}]`);
      for (const r of l.rows) lines.push(`  ${clock(r.ts)}  ${r.text.split("\n")[0]}`);
    }
  }
  return lines.join("\n");
}
