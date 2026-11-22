/**
 * cttc's archives, read-only (REQ-000033-sJpO9KMY Requirement 1, decision
 * D5; the layout is cttc's `sample_archive.py`): a `.cttc-record` or
 * `.cttc-metric` is a zip holding `manifest.json` (version 3) and, per
 * segment, `stats/*.json` (`{"series": {name: [[ts_ms, cpu %, mem %,
 * mem bytes, net bytes/s], ...]}}`) and `logs/*.jsonl` (`{"ts": ms, "text"}`
 * per line). Every segment is read; the file is never written.
 *
 * The manifest's `integrity_sha256` is the SHA-256 of its canonical JSON
 * (keys sorted, no spaces) without that field, as Python's `json.dumps`
 * writes it: numbers kept as written (`1786017654375.0`), so the canonical
 * text is built from the manifest's own text, not from parsed numbers. A
 * mismatch is a warning, as in cttc, not a refusal.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { DEFAULT_LIMITS, readZip, type ZipLimits } from "./zip.js";

/** One stats row: `[ts_ms, cpu %, mem %, mem bytes, net bytes/s]`, any but ts may be null. */
export type StatsRow = [number, number | null, number | null, number | null, number | null];

/** One log row. */
export interface LogRow {
  ts: number;
  text: string;
}

/** A file, read. */
export interface FileData {
  /** Its name, for the view. */
  label: string;
  path: string;
  /** Its time range, from the manifest's segments (ms). */
  from: number;
  to: number;
  /** Containers' stats, by name, oldest first. */
  stats: Map<string, StatsRow[]>;
  /** The host's stats, oldest first; empty without a host source. */
  host: StatsRow[];
  /** The host's name ("localhost" for cttc's local Docker host). */
  hostName: string | null;
  /** Logs by container, oldest first (ties in file order). */
  logs: Map<string, LogRow[]>;
  /** Every container, stats or logs, sorted. */
  containers: string[];
  warnings: string[];
}

interface ManifestSource {
  type: "stats" | "log";
  name: string;
  file: string;
  is_host?: boolean;
  docker_host_id?: string;
}

interface Manifest {
  version: number;
  segments: { from: number; to: number; sources: ManifestSource[] }[];
  integrity_sha256?: string;
}

/** Read a cttc archive's bytes; throws with the reason when it cannot. */
export function readCttcArchive(
  buf: Buffer,
  file: string,
  limits: ZipLimits = DEFAULT_LIMITS,
): FileData {
  const entries = readZip(buf, limits);
  const raw = entries.get("manifest.json");
  if (!raw) throw new Error("no manifest.json: not a cttc recording or metrics file");
  const text = raw.toString("utf8");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(text) as Manifest;
  } catch {
    throw new Error("manifest.json is not JSON");
  }
  if (manifest.version !== 3 || !Array.isArray(manifest.segments)) {
    throw new Error(`manifest version ${manifest.version} is not read (3 is)`);
  }
  const warnings: string[] = [];
  if (manifest.integrity_sha256 && manifest.integrity_sha256 !== manifestHash(text)) {
    warnings.push("the manifest's integrity hash does not match; read anyway");
  }
  const stats = new Map<string, StatsRow[]>();
  const host: StatsRow[] = [];
  const logs = new Map<string, LogRow[]>();
  let hostName: string | null = null;
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const segment of manifest.segments) {
    if (Number.isFinite(segment.from)) from = Math.min(from, segment.from);
    if (Number.isFinite(segment.to)) to = Math.max(to, segment.to);
    for (const source of segment.sources ?? []) {
      const body = entries.get(source.file);
      if (!body) {
        warnings.push(`${source.file} is listed but missing`);
        continue;
      }
      if (source.type === "stats") {
        const series = (JSON.parse(body.toString("utf8")) as { series?: Record<string, unknown[]> })
          .series;
        for (const [name, rows] of Object.entries(series ?? {})) {
          const clean = (rows ?? []).map(statsRow).filter((r): r is StatsRow => r !== null);
          if (source.is_host) {
            host.push(...clean);
            hostName ??= hostNameOf(source);
          } else {
            stats.set(name, [...(stats.get(name) ?? []), ...clean]);
          }
        }
      } else if (source.type === "log") {
        const rows = logs.get(source.name) ?? [];
        for (const line of body.toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line) as { ts?: unknown; text?: unknown };
            if (typeof row.ts === "number" && Number.isFinite(row.ts)) {
              rows.push({ ts: row.ts, text: typeof row.text === "string" ? row.text : "" });
            }
          } catch {
            warnings.push(`a line of ${source.file} is not JSON`);
          }
        }
        logs.set(source.name, rows);
      }
    }
  }
  const byTs = (a: { 0: number } | LogRow, b: { 0: number } | LogRow) =>
    ("ts" in a ? a.ts : a[0]) - ("ts" in b ? b.ts : b[0]);
  for (const rows of stats.values()) rows.sort(byTs);
  host.sort(byTs);
  for (const rows of logs.values()) rows.sort(byTs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new Error("the file covers no time range");
  }
  return {
    label: path.basename(file),
    path: file,
    from,
    to,
    stats,
    host,
    hostName,
    logs,
    containers: [...new Set([...stats.keys(), ...logs.keys()])].sort(),
    warnings,
  };
}

/** A stats row, or null when its time is not a number. */
function statsRow(row: unknown): StatsRow | null {
  if (!Array.isArray(row) || typeof row[0] !== "number" || !Number.isFinite(row[0])) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return [row[0], n(row[1]), n(row[2]), n(row[3]), n(row[4])];
}

/** cttc's host label: "localhost" for its local Docker host, else that host. */
function hostNameOf(source: ManifestSource): string {
  const id = source.docker_host_id ?? source.name.replace(/^host@/, "");
  return !id || id === "local" ? "localhost" : id;
}

/** SHA-256 of the manifest's canonical JSON without its hash, as cttc computed it. */
export function manifestHash(text: string): string {
  const value = parseRaw(text);
  if (value.kind === "object")
    value.entries = value.entries.filter(([k]) => k !== "integrity_sha256");
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** JSON as written: numbers and strings kept as their literals. */
type Raw =
  | { kind: "literal"; text: string }
  | { kind: "array"; items: Raw[] }
  | { kind: "object"; entries: [string, Raw][] };

/** Parse JSON keeping each literal's text; keys decoded (for sorting and matching). */
export function parseRaw(text: string): Raw {
  let at = 0;
  const space = () => {
    while (at < text.length && " \t\n\r".includes(text[at] as string)) at++;
  };
  const literal = (): string => {
    const start = at;
    if (text[at] === '"') {
      at++;
      while (at < text.length && text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
      at++;
    } else {
      while (at < text.length && !",]} \t\n\r".includes(text[at] as string)) at++;
    }
    return text.slice(start, at);
  };
  const value = (): Raw => {
    space();
    if (text[at] === "{") {
      at++;
      const entries: [string, Raw][] = [];
      space();
      while (text[at] !== "}") {
        space();
        const key = literal();
        space();
        at++; // :
        entries.push([key, value()]);
        space();
        if (text[at] === ",") at++;
        space();
      }
      at++;
      return { kind: "object", entries };
    }
    if (text[at] === "[") {
      at++;
      const items: Raw[] = [];
      space();
      while (text[at] !== "]") {
        items.push(value());
        space();
        if (text[at] === ",") at++;
        space();
      }
      at++;
      return { kind: "array", items };
    }
    return { kind: "literal", text: literal() };
  };
  const raw = value();
  // Keys are compared decoded, as Python's sort_keys does.
  const decode = (r: Raw): Raw =>
    r.kind === "object"
      ? { kind: "object", entries: r.entries.map(([k, v]) => [JSON.parse(k) as string, decode(v)]) }
      : r.kind === "array"
        ? { kind: "array", items: r.items.map(decode) }
        : r;
  return decode(raw);
}

/** Canonical text: keys sorted, no spaces, literals as written. */
function canonical(r: Raw): string {
  if (r.kind === "literal") return r.text;
  if (r.kind === "array") return `[${r.items.map(canonical).join(",")}]`;
  const sorted = [...r.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${sorted.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
