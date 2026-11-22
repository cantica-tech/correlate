/**
 * Capturing a range (br-EXPORT-000003-sJpO9KMY, cttc's `exportSample`
 * `app.js:1322`; REQ-000041-sJpO9KMY Requirement 2): the dragged range of
 * what the active view shows, saved as a `.recording` of one segment.
 *
 * Where to save is asked first, before anything is read
 * (br-EXPORT-000002-sJpO9KMY): cancelling reads and writes nothing. Then the
 * range comes from the window's Sump (`/records/segment`, the live view) or
 * is cut from the shown file (the analysis view), never from the other
 * (br-EXPORT-000001-sJpO9KMY), and is written atomically.
 */
import type { FileData } from "../analysis/archive.js";
import { appendToRecording, type SegmentData } from "../recording/archive.js";

/** A stream or container name: printable, at most 200 characters. */
const NAME = /^[\x21-\x7e]{1,200}$/;

/** What to capture: the view it comes from, what it shows, and the range (ms). */
export interface CaptureRequest {
  view: "live" | "file";
  /** The live view's data stream (unused for a file). */
  stream: string;
  /** The containers shown. */
  containers: string[];
  /** The host's block is shown. */
  host: boolean;
  from: number;
  to: number;
}

/** Check a capture's message from the app. */
export function parseCapture(message: unknown): CaptureRequest {
  const m = (message ?? {}) as Record<string, unknown>;
  const view = m.view === "file" ? "file" : m.view === "live" ? "live" : null;
  if (!view) throw new Error("a capture is of the live view or of a file");
  if (view === "live" && (typeof m.stream !== "string" || !NAME.test(m.stream)))
    throw new Error("not a data stream");
  const containers = Array.isArray(m.containers) ? m.containers : [];
  if (containers.length > 200 || !containers.every((c) => typeof c === "string" && NAME.test(c)))
    throw new Error("containers are up to 200 names");
  const from = Number(m.from);
  const to = Number(m.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
    throw new Error("a capture needs a range");
  return {
    view,
    stream: typeof m.stream === "string" ? m.stream : "",
    containers: containers as string[],
    host: m.host === true,
    from: Math.floor(from),
    to: Math.ceil(to),
  };
}

/** The shown file's range `from`..`to`, of `containers` (and the host), as a segment. */
export function sliceFile(
  file: FileData,
  containers: readonly string[],
  host: boolean,
  from: number,
  to: number,
): SegmentData {
  const inRange = (ts: number) => ts >= from && ts <= to;
  const series: Record<string, (number | null)[][]> = {};
  for (const name of containers) {
    const rows = (file.stats.get(name) ?? []).filter((r) => inRange(r[0]));
    if (rows.length > 0) series[name] = rows;
  }
  const sources: SegmentData["sources"] = [];
  if (Object.keys(series).length > 0)
    sources.push({ type: "stats", name: "stats@capture", is_host: false, series });
  const hostRows = host ? file.host.filter((r) => inRange(r[0])) : [];
  if (hostRows.length > 0) {
    const id = !file.hostName || file.hostName === "localhost" ? "local" : file.hostName;
    sources.push({ type: "stats", name: `host@${id}`, is_host: true, series: { [id]: hostRows } });
  }
  for (const name of containers) {
    const rows = (file.logs.get(name) ?? []).filter((r) => inRange(r.ts));
    if (rows.length > 0) sources.push({ type: "log", name, rows });
  }
  return { from, to, sources };
}

/** cttc's capture name, from its start: `capture-2026-11-22-14-05-00.recording`. */
export function captureName(from: number): string {
  return `capture-${new Date(from).toISOString().slice(0, 19).replace(/[T:]/g, "-")}.recording`;
}

/** What capturing needs. */
export interface CaptureDeps {
  /** The save dialog: the chosen path, or null when cancelled. */
  askSave: (suggested: string) => Promise<string | null>;
  /** The range from the window's Sump: `/records/segment`'s answer. */
  fetchSegment: (
    query: Record<string, string>,
  ) => Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>;
  /** The window's shown file, in the analysis view. */
  shownFile: () => FileData | undefined;
  /** Write the file atomically. */
  write: (file: string, bytes: Buffer) => Promise<void>;
}

/** What a capture answers: the file written, or why not. */
export type CaptureResult =
  | { ok: true; file: string; empty: boolean }
  | { ok: false; cancelled?: true; message?: string };

/** Capture `request`: the destination asked first, then the range read and written. Never throws. */
export async function capture(request: CaptureRequest, deps: CaptureDeps): Promise<CaptureResult> {
  const file = request.view === "file" ? deps.shownFile() : undefined;
  if (request.view === "file" && !file) return { ok: false, message: "this window shows no file" };
  const path = await deps.askSave(captureName(request.from));
  if (!path) return { ok: false, cancelled: true };
  try {
    let data: SegmentData;
    if (file) {
      data = sliceFile(file, request.containers, request.host, request.from, request.to);
    } else {
      const reply = await deps.fetchSegment({
        sources: request.containers.map((c) => `${request.stream}/${c}`).join(","),
        ...(request.host ? { host: `${request.stream}/__host__` } : {}),
        from: new Date(request.from).toISOString(),
        to: new Date(request.to).toISOString(),
      });
      if (!reply.ok) throw new Error(reply.error.message);
      data = reply.value as SegmentData;
    }
    await deps.write(path, appendToRecording(null, data, "new"));
    return { ok: true, file: path, empty: data.sources.length === 0 };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
