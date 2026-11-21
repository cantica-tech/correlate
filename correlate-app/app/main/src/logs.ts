/**
 * The log panels' main-process side (REQ-000029-sJpO9KMY Requirements 2-4,
 * br-LOGV-000001-sJpO9KMY):
 *
 * - `logs:prefs`, `logs:setPrefs`: the panels' order (newest or oldest first)
 *   and whether the lanes are open, kept in the settings file under `logs`.
 * - `logs:export`: Export .log. The save dialog comes first; only once a file
 *   is chosen are the container's rows over the view fetched, page by page
 *   through the window's Sump, and written as `time text` lines, owner-only.
 *   Cancelling fetches nothing.
 */
import { chmod, writeFile } from "node:fs/promises";
import type { IpcEventLike, IpcMainLike } from "./sump/ipc.js";
import type { Settings } from "./theme.js";

export const LOGS_PREFS_CHANNEL = "logs:prefs";
export const LOGS_SET_PREFS_CHANNEL = "logs:setPrefs";
export const LOGS_EXPORT_CHANNEL = "logs:export";

const PART = "logs";
/** Rows fetched per call while exporting: the Sump's most. */
export const EXPORT_PAGE = 1000;
/** An export stops at this many rows. */
export const EXPORT_MAX_ROWS = 2_000_000;
/** A source: `stream/container`, printable, at most 400 characters. */
const SOURCE = /^[\x21-\x7e]{1,400}$/;

/** The panels' remembered choices. */
export interface LogPrefs {
  order: "newest" | "oldest";
  lanesOpen: boolean;
}

/** What is remembered, or the defaults: newest first, lanes folded (cttc's). */
export function logPrefs(settings: Settings): LogPrefs {
  const part = settings.part(PART) as Partial<LogPrefs> | undefined;
  return {
    order: part?.order === "oldest" ? "oldest" : "newest",
    lanesOpen: part?.lanesOpen === true,
  };
}

/** Remember `change`; throws on anything else. */
export function setLogPrefs(settings: Settings, change: unknown): LogPrefs {
  const c = (change ?? {}) as Record<string, unknown>;
  const next = logPrefs(settings);
  for (const [key, value] of Object.entries(c)) {
    if (key === "order" && (value === "newest" || value === "oldest")) next.order = value;
    else if (key === "lanesOpen" && typeof value === "boolean") next.lanesOpen = value;
    else throw new Error(`no log preference ${key} of that value`);
  }
  settings.setPart(PART, next);
  return next;
}

/** What Export asks for. */
export interface ExportRequest {
  source: string;
  /** The container's name, for the file's default name. */
  name: string;
  from: string;
  to: string;
  order: "newest" | "oldest";
}

/** A Sump call's answer, as the Sump bridge gives it. */
export type SumpAnswer = { ok: true; value: unknown } | { ok: false; error: { message: string } };

/** What Export needs from Electron and the Sump bridge. */
export interface ExportDeps {
  /** The save dialog: the chosen path, or null when cancelled. */
  ask: (event: IpcEventLike, defaultName: string) => Promise<string | null>;
  /** One call to the calling window's Sump. */
  request: (
    event: IpcEventLike,
    message: { method: "GET"; path: string; query: Record<string, string | number> },
  ) => Promise<SumpAnswer>;
  /** Write the file; owner-only by default. */
  write?: (path: string, text: string) => Promise<void>;
  now?: () => Date;
}

/** Check Export's message; the renderer is not trusted to send a valid one. */
export function parseExport(message: unknown): ExportRequest {
  const m = (message ?? {}) as Record<string, unknown>;
  if (typeof m.source !== "string" || !SOURCE.test(m.source)) {
    throw new Error("source is up to 400 printable characters");
  }
  for (const key of ["from", "to"] as const) {
    if (typeof m[key] !== "string" || Number.isNaN(Date.parse(m[key] as string))) {
      throw new Error(`${key} must be a time`);
    }
  }
  const order = m.order === "oldest" ? "oldest" : "newest";
  const name = typeof m.name === "string" && m.name ? m.name : (m.source.split("/").pop() ?? "log");
  return { source: m.source, name, from: m.from as string, to: m.to as string, order };
}

/** A file name from a container's name and the time: cttc's `<name>-<stamp>.log`. */
export function exportName(name: string, now: Date): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "log";
  return `${safe}-${now.toISOString().slice(0, 19).replace(/[T:]/g, "-")}.log`;
}

/** Write `text` to `file`, readable by its owner only. */
async function writeOwnerOnly(file: string, text: string): Promise<void> {
  await writeFile(file, text, { mode: 0o600 });
  // A file that was already there keeps its mode on write.
  await chmod(file, 0o600);
}

/** Export .log; never throws. */
export async function exportLog(
  event: IpcEventLike,
  message: unknown,
  deps: ExportDeps,
): Promise<
  { ok: true; path: string; rows: number } | { ok: false; cancelled?: true; message?: string }
> {
  let m: ExportRequest;
  try {
    m = parseExport(message);
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  const file = await deps.ask(event, exportName(m.name, (deps.now ?? (() => new Date()))()));
  if (!file) return { ok: false, cancelled: true };
  const lines: string[] = [];
  let offset = 0;
  for (;;) {
    const reply = await deps.request(event, {
      method: "GET",
      path: "/records/logs",
      query: {
        source: m.source,
        from: m.from,
        to: m.to,
        order: m.order,
        offset,
        limit: EXPORT_PAGE,
      },
    });
    if (!reply.ok) return { ok: false, message: `could not read the logs: ${reply.error.message}` };
    const page = reply.value as { total: number; rows: { ts: string; text: string }[] };
    for (const row of page.rows) lines.push(`${row.ts} ${row.text}`);
    offset += page.rows.length;
    if (page.rows.length === 0 || offset >= page.total || offset >= EXPORT_MAX_ROWS) break;
  }
  try {
    await (deps.write ?? writeOwnerOnly)(file, lines.length ? `${lines.join("\n")}\n` : "");
  } catch (error) {
    return { ok: false, message: `could not write ${file}: ${(error as Error).message}` };
  }
  return { ok: true, path: file, rows: lines.length };
}

/** Answer the three channels. */
export function registerLogsIpc(ipcMain: IpcMainLike, settings: Settings, deps: ExportDeps): void {
  ipcMain.handle(LOGS_PREFS_CHANNEL, () => logPrefs(settings));
  ipcMain.handle(LOGS_SET_PREFS_CHANNEL, (_event, change) => {
    try {
      return { ok: true, prefs: setLogPrefs(settings, change) };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });
  ipcMain.handle(LOGS_EXPORT_CHANNEL, (event, message) => exportLog(event, message, deps));
}
