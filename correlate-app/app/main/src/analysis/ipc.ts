/**
 * The analysis view's main-process side (REQ-000033-sJpO9KMY,
 * REQ-000034-sJpO9KMY): each window's open files, in the order opened, keyed
 * by their full path (br-ANLYS-000005-sJpO9KMY), one of them active, each
 * read once and kept in memory while open.
 *
 * - `analysis:open`: the open dialog first (several files at once); each new
 *   file read, one already open switched to; the last chosen becomes active.
 *   A file without data, or one that cannot be read, is refused.
 * - `analysis:list`: the open files and the active one (Opened Data…).
 * - `analysis:switch` (path): make an open file the active one.
 * - `analysis:remove` (path): close it, the file on disk untouched; the
 *   active one falls back to the last opened of those left, or to none
 *   (live) when none are left (br-ANLYS-000006-sJpO9KMY).
 * - `analysis:close`: back to live; the files stay open.
 * - `analysis:request`: one of the views' queries, answered from the
 *   window's active file only (`answers.ts`).
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { IpcEventLike, IpcMainLike } from "../sump/ipc.js";
import { answer, type FileAnswer, type FileRequest } from "./answers.js";
import { type FileData, readCttcArchive } from "./archive.js";
import { DEFAULT_LIMITS } from "./zip.js";

export const ANALYSIS_OPEN_CHANNEL = "analysis:open";
export const ANALYSIS_LIST_CHANNEL = "analysis:list";
export const ANALYSIS_SWITCH_CHANNEL = "analysis:switch";
export const ANALYSIS_REMOVE_CHANNEL = "analysis:remove";
export const ANALYSIS_REQUEST_CHANNEL = "analysis:request";
export const ANALYSIS_CLOSE_CHANNEL = "analysis:close";

/** The extensions opened (decided in FEAT-000034-sJpO9KMY: cttc's, read-only). */
export const OPENED_EXTENSIONS = ["cttc-record", "cttc-metric"];

/** An open file, as the renderer sees it. */
export interface OpenInfo {
  path: string;
  label: string;
  from: number;
  to: number;
}

/** A window's open files and which one is shown. */
export interface OpenList {
  files: OpenInfo[];
  /** The active file's path, or null: the window shows live. */
  active: string | null;
}

/** The info of a file. */
const infoOf = (f: FileData): OpenInfo => ({
  path: f.path,
  label: f.label,
  from: f.from,
  to: f.to,
});

/** Whether a file holds anything to show: stats or log rows. */
export function hasData(file: FileData): boolean {
  if (file.host.length > 0) return true;
  for (const rows of file.stats.values()) if (rows.length > 0) return true;
  for (const rows of file.logs.values()) if (rows.length > 0) return true;
  return false;
}

/** Each window's open files, in the order opened, and its active one. */
export class OpenFiles {
  private readonly byWindow = new Map<
    number,
    { files: Map<string, FileData>; active: string | null }
  >();

  private of(window: number) {
    let entry = this.byWindow.get(window);
    if (!entry) {
      entry = { files: new Map(), active: null };
      this.byWindow.set(window, entry);
    }
    return entry;
  }

  /** The window's active file, or undefined in live. */
  get(window: number): FileData | undefined {
    const entry = this.byWindow.get(window);
    return entry?.active ? entry.files.get(entry.active) : undefined;
  }

  /** Whether `file` (a full path) is open in the window. */
  has(window: number, file: string): boolean {
    return this.byWindow.get(window)?.files.has(path.resolve(file)) ?? false;
  }

  /** Keep `data` open in the window and make it active. */
  set(window: number, data: FileData): void {
    const entry = this.of(window);
    entry.files.set(data.path, data);
    entry.active = data.path;
  }

  /** Make an open file active; false when it is not open. */
  switchTo(window: number, file: string): boolean {
    const entry = this.byWindow.get(window);
    const key = path.resolve(file);
    if (!entry?.files.has(key)) return false;
    entry.active = key;
    return true;
  }

  /** Close an open file; the active one falls back to the last opened left, or none. */
  remove(window: number, file: string): void {
    const entry = this.byWindow.get(window);
    if (!entry) return;
    const key = path.resolve(file);
    entry.files.delete(key);
    if (entry.active === key) entry.active = [...entry.files.keys()].pop() ?? null;
  }

  /** Back to live: no file active, the files kept open. */
  leave(window: number): void {
    const entry = this.byWindow.get(window);
    if (entry) entry.active = null;
  }

  /** The window's open files and its active one. */
  list(window: number): OpenList {
    const entry = this.byWindow.get(window);
    return {
      files: [...(entry?.files.values() ?? [])].map(infoOf),
      active: entry?.active ?? null,
    };
  }

  /** The window closed: every file forgotten. */
  close(window: number): void {
    this.byWindow.delete(window);
  }
}

/** What opening needs from Electron and the disk. */
export interface AnalysisDeps {
  /** The open dialog: the chosen paths, none when cancelled. */
  ask: (event: IpcEventLike) => Promise<string[]>;
  /** The file's size in bytes; the disk's by default. */
  size?: (file: string) => Promise<number>;
  /** The file's bytes; the disk's by default. */
  read?: (file: string) => Promise<Buffer>;
}

/** What `analysis:open` answers. */
export type OpenAnswer =
  | (OpenList & { ok: true; refused: string[]; warnings: string[] })
  | { ok: false; cancelled?: true; refused?: string[] };

const windowOf = (event: IpcEventLike) => event?.sender?.id ?? -1;

/**
 * Ask for files and open them in the window: each new one read (refused when
 * it cannot be, or holds no data), one already open switched to; the last
 * one chosen that is open becomes active. Never throws.
 */
export async function openFiles(
  event: IpcEventLike,
  files: OpenFiles,
  deps: AnalysisDeps,
): Promise<OpenAnswer> {
  const chosen = (await deps.ask(event)).map((f) => path.resolve(f));
  if (chosen.length === 0) return { ok: false, cancelled: true };
  const window = windowOf(event);
  const size = deps.size ?? (async (f: string) => (await stat(f)).size);
  const read = deps.read ?? ((f: string) => readFile(f));
  const refused: string[] = [];
  const warnings: string[] = [];
  let last: string | null = null;
  for (const file of chosen) {
    if (files.has(window, file)) {
      last = file;
      continue;
    }
    try {
      if ((await size(file)) > DEFAULT_LIMITS.bytes) {
        throw new Error(`larger than ${DEFAULT_LIMITS.bytes / 1024 / 1024} MB`);
      }
      const data = readCttcArchive(await read(file), file);
      if (!hasData(data)) throw new Error("it holds no data");
      files.set(window, data);
      warnings.push(...data.warnings.map((w) => `${data.label}: ${w}`));
      last = file;
    } catch (error) {
      refused.push(`Could not open ${file}: ${(error as Error).message}`);
    }
  }
  if (last === null) return { ok: false, refused };
  files.switchTo(window, last);
  return { ok: true, ...files.list(window), refused, warnings };
}

/** Answer a query for the window's active file; refused when it shows live. */
export function fileRequest(files: OpenFiles, window: number, message: unknown): FileAnswer {
  const file = files.get(window);
  if (!file) {
    const why = "this window shows no file";
    return { ok: false, error: { kind: "http", message: why, status: 409, detail: why } };
  }
  return answer(file, (message ?? {}) as FileRequest);
}

/** Answer the channels. */
export function registerAnalysisIpc(ipcMain: IpcMainLike, files: OpenFiles, deps: AnalysisDeps) {
  ipcMain.handle(ANALYSIS_OPEN_CHANNEL, (event) => openFiles(event, files, deps));
  ipcMain.handle(ANALYSIS_LIST_CHANNEL, (event) => files.list(windowOf(event)));
  ipcMain.handle(ANALYSIS_SWITCH_CHANNEL, (event, file) => {
    const window = windowOf(event);
    const ok = typeof file === "string" && files.switchTo(window, file);
    return { ok, ...files.list(window) };
  });
  ipcMain.handle(ANALYSIS_REMOVE_CHANNEL, (event, file) => {
    const window = windowOf(event);
    if (typeof file === "string") files.remove(window, file);
    return { ok: true, ...files.list(window) };
  });
  ipcMain.handle(ANALYSIS_REQUEST_CHANNEL, (event, message) =>
    fileRequest(files, windowOf(event), message),
  );
  ipcMain.handle(ANALYSIS_CLOSE_CHANNEL, (event) => {
    files.leave(windowOf(event));
    return { ok: true };
  });
}
