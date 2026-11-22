/**
 * Exporting a loaded file (br-EXPORT-000005-sJpO9KMY, cttc's Export metrics,
 * `gatherExportMetricsData` and `exportMetricsToText`, `app.js:1600-1800`;
 * REQ-000042-sJpO9KMY Requirement 2): the shown file's whole range, its
 * stats and/or logs, as text or JSON, a summary or every row.
 *
 * Only what the analysis view shows (br-EXPORT-000001-sJpO9KMY): the file's
 * containers not hidden in the legend, and its host when the host block is
 * open; at the times shown, each track's delay applied, the header naming the
 * shifted tracks. Where to save is asked first (br-EXPORT-000002-sJpO9KMY):
 * a cancel builds and writes nothing.
 */
import type { FileData, StatsRow } from "../analysis/archive.js";

/** cttc's explanation of the stats fields, in every export of them. */
export const STATS_FIELD_EXPLANATIONS = [
  "cpu: percent of one CPU core in use (can exceed 100% for a multi-core container)",
  "mem: percent of the container's own memory limit in use (not host RAM)",
  "mem_bytes: memory in use, in bytes",
  "net: combined rx+tx network throughput at that instant, in bytes/sec",
];

/** The stats fields, in a row's order after its time. */
const FIELDS = ["cpu", "mem", "mem_bytes", "net"] as const;
type Field = (typeof FIELDS)[number];

/** What the dialog asks for. */
export interface MetricsRequest {
  stats: boolean;
  logs: boolean;
  format: "text" | "json";
  detail: "summary" | "full";
}

/** Check the dialog's message. */
export function parseMetrics(message: unknown): MetricsRequest {
  const m = (message ?? {}) as Record<string, unknown>;
  const request: MetricsRequest = {
    stats: m.stats === true,
    logs: m.logs === true,
    format: m.format === "json" ? "json" : "text",
    detail: m.detail === "full" ? "full" : "summary",
  };
  if (!request.stats && !request.logs) throw new Error("nothing to export: pick stats or logs");
  return request;
}

/** What the window shows of its file: its containers, its host, its tracks' delays (s). */
export interface MetricsScope {
  file: FileData;
  containers: readonly string[];
  host: boolean;
  delays: Readonly<Record<string, number>>;
}

/** A field's first, last, min, max and mean over the rows that have it. */
export interface FieldSummary {
  first: number;
  last: number;
  min: number;
  max: number;
  mean: number;
}

/** One sample, at its shown time (ms). */
export interface Sample {
  ts: number;
  cpu: number | null;
  mem: number | null;
  mem_bytes: number | null;
  net: number | null;
}

/** One container's (or the host's) stats. */
export interface ServiceStats {
  name: string;
  host: boolean;
  count: number;
  /** Seconds its times are shifted by, when a delay is set. */
  delay?: number;
  summary?: Partial<Record<Field, FieldSummary>>;
  samples?: Sample[];
}

/** An export, as its JSON has it (times in epoch ms). */
export interface MetricsExport {
  generated_at: string;
  from: number;
  to: number;
  /** The shifted tracks, in seconds. */
  delays: Record<string, number>;
  stats?: { granularity: "summary" | "full"; services: ServiceStats[] };
  logs?: { source: string; delay?: number; rows: { ts: number; text: string }[] }[];
}

/** A row as a sample, shifted by `shiftMs`. */
function sampleOf(row: StatsRow, shiftMs: number): Sample {
  return { ts: row[0] + shiftMs, cpu: row[1], mem: row[2], mem_bytes: row[3], net: row[4] };
}

/** Each field's summary over `samples`, the fields with no value left out. */
export function summarize(samples: readonly Sample[]): Partial<Record<Field, FieldSummary>> {
  const out: Partial<Record<Field, FieldSummary>> = {};
  for (const field of FIELDS) {
    const values = samples.map((s) => s[field]).filter((v): v is number => v !== null);
    if (values.length === 0) continue;
    out[field] = {
      first: values[0],
      last: values[values.length - 1],
      min: Math.min(...values),
      max: Math.max(...values),
      mean: values.reduce((a, b) => a + b, 0) / values.length,
    };
  }
  return out;
}

/** The export of `scope` as `request` asks, generated at `now`. */
export function buildExport(
  scope: MetricsScope,
  request: MetricsRequest,
  now: Date = new Date(),
): MetricsExport {
  const { file } = scope;
  const delays: Record<string, number> = {};
  for (const name of [...scope.containers, ...(scope.host ? ["__host__"] : [])]) {
    const d = scope.delays[name];
    if (d) delays[name] = d;
  }
  const shift = (name: string) => (delays[name] ?? 0) * 1000;
  const out: MetricsExport = {
    generated_at: now.toISOString(),
    from: file.from,
    to: file.to,
    delays,
  };
  if (request.stats) {
    const series: { name: string; key: string; host: boolean; rows: readonly StatsRow[] }[] = [];
    if (scope.host && file.host.length > 0)
      series.push({ name: file.hostName ?? "host", key: "__host__", host: true, rows: file.host });
    for (const name of scope.containers) {
      const rows = file.stats.get(name);
      if (rows && rows.length > 0) series.push({ name, key: name, host: false, rows });
    }
    out.stats = {
      granularity: request.detail,
      services: series.map((s) => {
        const samples = s.rows.map((r) => sampleOf(r, shift(s.key)));
        return {
          name: s.name,
          host: s.host,
          count: samples.length,
          ...(delays[s.key] ? { delay: delays[s.key] } : {}),
          ...(request.detail === "summary" ? { summary: summarize(samples) } : { samples }),
        };
      }),
    };
  }
  if (request.logs) {
    out.logs = scope.containers.flatMap((name) => {
      const rows = file.logs.get(name);
      if (!rows || rows.length === 0) return [];
      const ms = shift(name);
      return [
        {
          source: name,
          ...(delays[name] ? { delay: delays[name] } : {}),
          rows: rows.map((r) => ({ ts: r.ts + ms, text: r.text })),
        },
      ];
    });
  }
  return out;
}

/** A full UTC time: `2026-11-22 12:00:30.000 UTC`. */
export function utc(t: number): string {
  return new Date(t).toISOString().replace("T", " ").replace("Z", " UTC");
}

/** cttc's `fmtBytes`, for sizes. */
function bytes(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} GB`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)} kB`;
  return `${v.toFixed(0)} B`;
}

/** Each field's value as the summary writes it. */
const FORMAT: Record<Field, (v: number) => string> = {
  cpu: (v) => `${v.toFixed(1)}%`,
  mem: (v) => `${v.toFixed(1)}%`,
  mem_bytes: bytes,
  net: (v) => `${bytes(v)}/s`,
};

/** A delay in words: `+2s`, `-1.5s`. */
function delayWords(seconds: number): string {
  return `${seconds > 0 ? "+" : ""}${seconds}s`;
}

/** cttc's `exportMetricsToText`, with full UTC times and the delays said. */
export function exportToText(data: MetricsExport): string {
  const lines = [`Metrics export @ ${data.generated_at}`];
  lines.push(`Range: ${utc(data.from)} — ${utc(data.to)}`);
  const shifted = Object.entries(data.delays);
  if (shifted.length > 0) {
    lines.push(
      `Delays applied: ${shifted.map(([n, s]) => `${n === "__host__" ? "host" : n} ${delayWords(s)}`).join(", ")}`,
    );
  }
  if (data.stats) {
    lines.push("");
    lines.push(
      data.stats.granularity === "summary"
        ? "== Stats (summary) =="
        : "== Stats (full time series) ==",
    );
    lines.push(...STATS_FIELD_EXPLANATIONS);
    for (const svc of data.stats.services) {
      lines.push("");
      lines.push(`[${(svc.host ? "* " : "") + svc.name}]`);
      if (svc.summary) {
        for (const key of FIELDS) {
          const s = svc.summary[key];
          if (!s) continue;
          const f = FORMAT[key];
          lines.push(
            `  ${key}: first ${f(s.first)}  last ${f(s.last)}  min ${f(s.min)}  max ${f(s.max)}  mean ${f(s.mean)}  (${svc.count} samples)`,
          );
        }
      } else {
        for (const s of svc.samples ?? []) {
          lines.push(
            `  ${utc(s.ts)}  cpu=${s.cpu ?? "-"}  mem=${s.mem ?? "-"}  mem_bytes=${s.mem_bytes ?? "-"}  net=${s.net ?? "-"}`,
          );
        }
      }
    }
  }
  if (data.logs) {
    lines.push("");
    lines.push("== Logs ==");
    for (const l of data.logs) {
      lines.push("");
      lines.push(`[${l.source}]`);
      for (const row of l.rows) lines.push(`  ${utc(row.ts)}  ${row.text.split("\n")[0]}`);
    }
  }
  return lines.join("\n");
}

/** cttc's export name, from when it is made: `metrics-export-2026-11-22-12-00-30.txt`. */
export function exportName(now: Date, format: "text" | "json"): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return `metrics-export-${stamp}.${format === "json" ? "json" : "txt"}`;
}

/** What exporting needs. */
export interface MetricsDeps {
  /** What the window shows of its file, or undefined when it shows live. */
  scope: () => MetricsScope | undefined;
  /** The save dialog: the chosen path, or null when cancelled. */
  askSave: (name: string, format: "text" | "json") => Promise<string | null>;
  /** Write the file atomically. */
  write: (file: string, content: string) => Promise<void>;
  now?: () => Date;
}

/** What an export answers. */
export type MetricsResult =
  | { ok: true; file: string }
  | { ok: false; cancelled?: true; message?: string };

/** Export what `request` asks of the shown file: the destination first. Never throws. */
export async function exportMetrics(
  request: MetricsRequest,
  deps: MetricsDeps,
): Promise<MetricsResult> {
  const scope = deps.scope();
  if (!scope)
    return { ok: false, message: "Export Metrics needs a file shown in the analysis view" };
  const now = (deps.now ?? (() => new Date()))();
  const path = await deps.askSave(exportName(now, request.format), request.format);
  if (!path) return { ok: false, cancelled: true };
  try {
    const data = buildExport(scope, request, now);
    await deps.write(
      path,
      request.format === "json" ? JSON.stringify(data, null, 2) : exportToText(data),
    );
    return { ok: true, file: path };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
