/**
 * The analysis view's main-process side (REQ-000033-sJpO9KMY,
 * REQ-000034-sJpO9KMY): each window's open files, in the order opened, keyed
 * by their full path (br-ANLYS-000005-sJpO9KMY), one of them active, each
 * read once and kept in memory while open.
 *
 * `openFiles` reads several files at once (each new one read, one already
 * open switched to; the last becomes active; a file without data, or one that
 * cannot be read, refused); `OpenFiles.remove` closes one, the file on disk
 * untouched, the active one falling back to the last opened of those left, or
 * to none (live) (br-ANLYS-000006-sJpO9KMY). The project's channels
 * (REQ-000035-sJpO9KMY) use both.
 *
 * - `analysis:list`: the open files and the active one.
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

export const ANALYSIS_LIST_CHANNEL = "analysis:list";
export const ANALYSIS_REQUEST_CHANNEL = "analysis:request";
export const ANALYSIS_CLOSE_CHANNEL = "analysis:close";

/**
 * The extensions opened: the app's own `*.recording` and `*.track` (read as
 * the cttc archives they continue, REQ-000036-sJpO9KMY) and cttc's, read-only.
 */
export const OPENED_EXTENSIONS = ["recording", "track", "cttc-record", "cttc-metric"];

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
    const key = path.resolve(data.path);
    entry.files.set(key, data);
    entry.active = key;
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
      files: [...(entry?.files.entries() ?? [])].map(([key, f]) => ({ ...infoOf(f), path: key })),
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

/** Answer a query for the window's active file, its tracks' delays applied; refused in live. */
export function fileRequest(
  files: OpenFiles,
  window: number,
  message: unknown,
  delays: Record<string, number> = {},
): FileAnswer {
  const file = files.get(window);
  if (!file) {
    const why = "this window shows no file";
    return { ok: false, error: { kind: "http", message: why, status: 409, detail: why } };
  }
  return answer(file, (message ?? {}) as FileRequest, delays);
}

/**
 * Answer the analysis view's channels (its files are opened, shown and removed
 * through the project's, `../projects/ipc.ts`); `delays` gives the shown
 * file's tracks' delays, in seconds, by container.
 */
export function registerAnalysisIpc(
  ipcMain: IpcMainLike,
  files: OpenFiles,
  delays: (window: number) => Record<string, number> = () => ({}),
) {
  ipcMain.handle(ANALYSIS_LIST_CHANNEL, (event) => files.list(windowOf(event)));
  ipcMain.handle(ANALYSIS_REQUEST_CHANNEL, (event, message) => {
    const window = windowOf(event);
    return fileRequest(files, window, message, delays(window));
  });
  ipcMain.handle(ANALYSIS_CLOSE_CHANNEL, (event) => {
    files.leave(windowOf(event));
    return { ok: true };
  });
}
