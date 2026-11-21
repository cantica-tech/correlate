/**
 * The data-stream picker's last stream, per Sump (REQ-000026-sJpO9KMY
 * Requirement 3, decided in FEAT-000027-sJpO9KMY): Edit Data Streams… opens
 * on the stream last submitted on that Sump. Kept in the settings file under
 * `pickerLastStream`, beside the theme; only short plain strings are kept.
 */
import type { IpcMainLike } from "./sump/ipc.js";
import type { Settings } from "./theme.js";

export const PICKER_LAST_CHANNEL = "picker:lastStream";
export const PICKER_SET_LAST_CHANNEL = "picker:setLastStream";

const PART = "pickerLastStream";
/** A Sump or stream id: printable, no control characters, at most 200 long. */
const ID = /^[\x21-\x7e]{1,200}$/;

function saved(settings: Settings): Record<string, string> {
  const part = settings.part(PART);
  if (typeof part !== "object" || part === null || Array.isArray(part)) return {};
  return Object.fromEntries(
    Object.entries(part).filter(
      (entry): entry is [string, string] =>
        ID.test(entry[0]) && typeof entry[1] === "string" && ID.test(entry[1]),
    ),
  );
}

/** The stream last submitted on `sump`, if any. */
export function lastStream(settings: Settings, sump: unknown): string | null {
  return typeof sump === "string" ? (saved(settings)[sump] ?? null) : null;
}

/** Remember `stream` as the last on `sump`; throws on anything but two ids. */
export function setLastStream(settings: Settings, sump: unknown, stream: unknown): void {
  if (
    typeof sump !== "string" ||
    !ID.test(sump) ||
    typeof stream !== "string" ||
    !ID.test(stream)
  ) {
    throw new Error("a Sump id and a stream id, each up to 200 printable characters");
  }
  settings.setPart(PART, { ...saved(settings), [sump]: stream });
}

/** Answer the picker's two channels; a refused value answers `{ ok: false }`. */
export function registerPickerIpc(ipcMain: IpcMainLike, settings: Settings): void {
  ipcMain.handle(PICKER_LAST_CHANNEL, (_event, sump) => lastStream(settings, sump));
  ipcMain.handle(PICKER_SET_LAST_CHANNEL, (_event, message) => {
    const m = (message ?? {}) as { sump?: unknown; stream?: unknown };
    try {
      setLastStream(settings, m.sump, m.stream);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });
}
