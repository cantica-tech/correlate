/**
 * Writing a `*.recording` (REQ-000037-sJpO9KMY Requirement 3): cttc's
 * archive format version 3 (`sample_archive.py`), read back by
 * `../analysis/archive.ts`: a zip of `manifest.json` (its segments, each with
 * its sources' files, and its integrity hash) and, per segment,
 * `segN/stats/*.json` and `segN/logs/*.jsonl`.
 *
 * A recording grows by segments (a span from Record to Pause) and, within the
 * segment being recorded, by pieces (the 10-minute flushes): a piece extends
 * its segment's series and logs and moves its end.
 */
import { manifestHash } from "../analysis/archive.js";
import { readZip } from "../analysis/zip.js";
import { zip } from "../analysis/zipWrite.js";

/** One stats row: `[ts ms, cpu %, mem %, mem bytes, net bytes/s]`. */
export type StatsRow = (number | null)[];

/** A segment, or a piece of one, as the Sump's `/records/segment` answers. */
export interface SegmentData {
  from: number;
  to: number;
  sources: (
    | { type: "stats"; name: string; is_host: boolean; series: Record<string, StatsRow[]> }
    | { type: "log"; name: string; rows: { ts: number; text: string }[] }
  )[];
}

interface ManifestSource {
  type: "stats" | "log";
  name: string;
  file: string;
  is_host?: boolean;
  count?: number;
}

interface Manifest {
  version: 3;
  segments: { from: number; to: number; created: string; sources: ManifestSource[] }[];
  integrity_sha256?: string;
}

/** A recording held in memory: its manifest and its files. */
interface Held {
  manifest: Manifest;
  files: Map<string, string>;
}

/** Read a recording written by this module (or cttc), or an empty one. */
function hold(existing: Buffer | null): Held {
  if (!existing || existing.length === 0) {
    return { manifest: { version: 3, segments: [] }, files: new Map() };
  }
  const entries = readZip(existing);
  const raw = entries.get("manifest.json");
  if (!raw) throw new Error("the recording has no manifest.json");
  const manifest = JSON.parse(raw.toString("utf8")) as Manifest;
  delete manifest.integrity_sha256;
  const files = new Map<string, string>();
  for (const [name, body] of entries)
    if (name !== "manifest.json") files.set(name, body.toString("utf8"));
  return { manifest, files };
}

/** The recording's bytes, its manifest's hash written as cttc's. */
function written(held: Held): Buffer {
  const bare = JSON.stringify(held.manifest);
  const manifest = { ...held.manifest, integrity_sha256: manifestHash(bare) };
  const entries: Record<string, string> = {};
  for (const [name, body] of held.files) entries[name] = body;
  entries["manifest.json"] = JSON.stringify(manifest);
  return zip(entries);
}

/** A new segment's files and manifest entry. */
function addSegment(held: Held, data: SegmentData, created: string): void {
  const n = held.manifest.segments.length;
  const sources: ManifestSource[] = data.sources.map((source, i) => {
    if (source.type === "stats") {
      const file = `seg${n}/stats/${i}.json`;
      held.files.set(file, JSON.stringify({ series: source.series }));
      return { type: "stats", name: source.name, file, is_host: source.is_host };
    }
    const file = `seg${n}/logs/${i}.jsonl`;
    held.files.set(file, source.rows.map((r) => JSON.stringify(r)).join("\n"));
    return { type: "log", name: source.name, file, count: source.rows.length };
  });
  held.manifest.segments.push({ from: data.from, to: data.to, created, sources });
}

/** Extend the last segment by a piece: its series and logs grow, its end moves. */
function extendSegment(held: Held, data: SegmentData): void {
  const last = held.manifest.segments[held.manifest.segments.length - 1];
  if (!last) throw new Error("no segment to extend");
  const n = held.manifest.segments.length - 1;
  last.to = data.to;
  for (const source of data.sources) {
    const known = last.sources.find((s) => s.type === source.type && s.name === source.name);
    if (source.type === "stats") {
      if (!known) {
        const file = `seg${n}/stats/${last.sources.length}.json`;
        held.files.set(file, JSON.stringify({ series: source.series }));
        last.sources.push({ type: "stats", name: source.name, file, is_host: source.is_host });
        continue;
      }
      const before = JSON.parse(held.files.get(known.file) ?? "{}") as {
        series?: Record<string, StatsRow[]>;
      };
      const series = before.series ?? {};
      for (const [name, rows] of Object.entries(source.series)) {
        const seen = new Set((series[name] ?? []).map((r) => r[0]));
        series[name] = [...(series[name] ?? []), ...rows.filter((r) => !seen.has(r[0]))];
      }
      held.files.set(known.file, JSON.stringify({ series }));
    } else {
      if (!known) {
        const file = `seg${n}/logs/${last.sources.length}.jsonl`;
        held.files.set(file, source.rows.map((r) => JSON.stringify(r)).join("\n"));
        last.sources.push({ type: "log", name: source.name, file, count: source.rows.length });
        continue;
      }
      const before = held.files.get(known.file) ?? "";
      const added = source.rows.map((r) => JSON.stringify(r)).join("\n");
      held.files.set(known.file, before && added ? `${before}\n${added}` : before || added);
      known.count = (known.count ?? 0) + source.rows.length;
    }
  }
}

/**
 * `existing` (or nothing) with `data` written: as a new segment, or as a
 * piece extending the last one. `created` is the new segment's ISO time.
 */
export function appendToRecording(
  existing: Buffer | null,
  data: SegmentData,
  piece: "new" | "extend",
  created: string = new Date().toISOString(),
): Buffer {
  const held = hold(existing);
  if (piece === "extend" && held.manifest.segments.length > 0) extendSegment(held, data);
  else addSegment(held, data, created);
  return written(held);
}
