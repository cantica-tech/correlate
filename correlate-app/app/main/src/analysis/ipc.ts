/**
 * The analysis view's main-process side (REQ-000033-sJpO9KMY Requirements 1-3):
 * each window's open file, read once and kept in memory while it is open.
 *
 * - `analysis:open`: the open dialog first; a chosen cttc file read and kept
 *   for the calling window (any file it had is replaced).
 * - `analysis:request`: one of the views' queries, answered from the
 *   calling window's file only (`answers.ts`).
 * - `analysis:close`: back to live; the file forgotten.
 */
import { readFile, stat } from "node:fs/promises";
import type { IpcEventLike, IpcMainLike } from "../sump/ipc.js";
import { answer, type FileAnswer, type FileRequest } from "./answers.js";
import { type FileData, readCttcArchive } from "./archive.js";
import { DEFAULT_LIMITS } from "./zip.js";

export const ANALYSIS_OPEN_CHANNEL = "analysis:open";
export const ANALYSIS_REQUEST_CHANNEL = "analysis:request";
export const ANALYSIS_CLOSE_CHANNEL = "analysis:close";

/** The extensions opened (decided in FEAT-000034-sJpO9KMY: cttc's, read-only). */
export const OPENED_EXTENSIONS = ["cttc-record", "cttc-metric"];

/** Each window's open file. */
export class OpenFiles {
  private readonly byWindow = new Map<number, FileData>();

  get(window: number): FileData | undefined {
    return this.byWindow.get(window);
  }

  set(window: number, file: FileData): void {
    this.byWindow.set(window, file);
  }

  /** A window went back to live, or closed. */
  close(window: number): void {
    this.byWindow.delete(window);
  }
}

/** What opening needs from Electron and the disk. */
export interface AnalysisDeps {
  /** The open dialog: the chosen path, or null when cancelled. */
  ask: (event: IpcEventLike) => Promise<string | null>;
  /** The file's size in bytes; the disk's by default. */
  size?: (file: string) => Promise<number>;
  /** The file's bytes; the disk's by default. */
  read?: (file: string) => Promise<Buffer>;
}

/** What `analysis:open` answers. */
export type OpenAnswer =
  | { ok: true; label: string; path: string; from: number; to: number; warnings: string[] }
  | { ok: false; cancelled?: true; message?: string };

const windowOf = (event: IpcEventLike) => event?.sender?.id ?? -1;

/** Ask for a file, read it, and keep it for the window; never throws. */
export async function openFile(
  event: IpcEventLike,
  files: OpenFiles,
  deps: AnalysisDeps,
): Promise<OpenAnswer> {
  const file = await deps.ask(event);
  if (!file) return { ok: false, cancelled: true };
  try {
    const size = deps.size ?? (async (f: string) => (await stat(f)).size);
    const read = deps.read ?? ((f: string) => readFile(f));
    if ((await size(file)) > DEFAULT_LIMITS.bytes) {
      throw new Error(`larger than ${DEFAULT_LIMITS.bytes / 1024 / 1024} MB`);
    }
    const data = readCttcArchive(await read(file), file);
    files.set(windowOf(event), data);
    return {
      ok: true,
      label: data.label,
      path: data.path,
      from: data.from,
      to: data.to,
      warnings: data.warnings,
    };
  } catch (error) {
    return { ok: false, message: `Could not open ${file}: ${(error as Error).message}` };
  }
}

/** Answer a query for the window's file; refused when it has none. */
export function fileRequest(files: OpenFiles, window: number, message: unknown): FileAnswer {
  const file = files.get(window);
  if (!file) {
    const message_ = "this window has no file open";
    return { ok: false, error: { kind: "http", message: message_, status: 409, detail: message_ } };
  }
  return answer(file, (message ?? {}) as FileRequest);
}

/** Answer the three channels. */
export function registerAnalysisIpc(ipcMain: IpcMainLike, files: OpenFiles, deps: AnalysisDeps) {
  ipcMain.handle(ANALYSIS_OPEN_CHANNEL, (event) => openFile(event, files, deps));
  ipcMain.handle(ANALYSIS_REQUEST_CHANNEL, (event, message) =>
    fileRequest(files, windowOf(event), message),
  );
  ipcMain.handle(ANALYSIS_CLOSE_CHANNEL, (event) => {
    files.close(windowOf(event));
    return { ok: true };
  });
}
