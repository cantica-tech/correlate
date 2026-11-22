/**
 * The exports' channels (REQ-000041-sJpO9KMY):
 *
 * - `export:capture` (`CaptureRequest`): a dragged range saved as a
 *   `.recording` (br-EXPORT-000003-sJpO9KMY); the app then adds it to the
 *   project, which shows it.
 * - `export:saveSnapshot` (`{ name, content, kind: "txt" | "json" }`): a
 *   snapshot already shown, saved where the user chooses
 *   (br-EXPORT-000004-sJpO9KMY).
 *
 * Both ask where to save first, write atomically, and never throw.
 */
import type { IpcEventLike, IpcMainLike } from "../sump/ipc.js";
import { type CaptureDeps, type CaptureResult, capture, parseCapture } from "./capture.js";

export const EXPORT_CAPTURE_CHANNEL = "export:capture";
export const EXPORT_SAVE_SNAPSHOT_CHANNEL = "export:saveSnapshot";

/** A snapshot's file name: printable, no folder, at most 200 characters. */
function fileName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > 200) return false;
  return [...name].every((c) => c >= " " && c !== "/" && c !== "\\");
}

/** What the channels need, per calling window. */
export interface ExportDeps {
  capture: (event: IpcEventLike) => CaptureDeps;
  /** The save dialog for a snapshot: the chosen path, or null when cancelled. */
  askSaveSnapshot: (
    event: IpcEventLike,
    name: string,
    kind: "txt" | "json",
  ) => Promise<string | null>;
  /** Write the file atomically. */
  write: (file: string, content: string) => Promise<void>;
}

/** What saving a snapshot answers. */
export type SaveResult =
  | { ok: true; file: string }
  | { ok: false; cancelled?: true; message?: string };

/** Save a snapshot's text: the destination asked first. Never throws. */
export async function saveSnapshot(
  event: IpcEventLike,
  message: unknown,
  deps: ExportDeps,
): Promise<SaveResult> {
  const m = (message ?? {}) as Record<string, unknown>;
  const kind = m.kind === "json" ? "json" : m.kind === "txt" ? "txt" : null;
  if (!kind || !fileName(m.name) || typeof m.content !== "string")
    return { ok: false, message: "not a snapshot" };
  const file = await deps.askSaveSnapshot(event, m.name, kind);
  if (!file) return { ok: false, cancelled: true };
  try {
    await deps.write(file, m.content);
    return { ok: true, file };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

/** Answer the exports' channels. */
export function registerExportIpc(ipcMain: IpcMainLike, deps: ExportDeps): void {
  ipcMain.handle(EXPORT_CAPTURE_CHANNEL, async (event, message): Promise<CaptureResult> => {
    try {
      return await capture(parseCapture(message), deps.capture(event));
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });
  ipcMain.handle(EXPORT_SAVE_SNAPSHOT_CHANNEL, (event, message) =>
    saveSnapshot(event, message, deps),
  );
}
