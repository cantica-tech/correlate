/**
 * The recording session for the windows (REQ-000037-sJpO9KMY): one session
 * for the app, told to every window as it changes.
 *
 * - `recording:get`: its state.
 * - `recording:start` (`{ stream, containers, host }`, the window's active
 *   stream): start on the window's Sump, or resume.
 * - `recording:pause`, `recording:stop`.
 * - `recording:resume` (`"interruption"` or `"now"`): the recovery dialog's
 *   choice after a crash (REQ-000038-sJpO9KMY).
 * - `recording:discard`: abandon it, once the user confirmed
 *   (REQ-000039-sJpO9KMY).
 * - `recording:changed` (to every window): the new state.
 */
import { copyFile, readFile, rename, rm } from "node:fs/promises";
import { writeAtomic } from "../projects/store.js";
import type { IpcEventLike, IpcMainLike } from "../sump/ipc.js";
import {
  parseMarker,
  type RecordingDeps,
  type RecordingMarker,
  type RecordingSession,
  type RecordingTarget,
} from "./session.js";

export const RECORDING_GET_CHANNEL = "recording:get";
export const RECORDING_START_CHANNEL = "recording:start";
export const RECORDING_PAUSE_CHANNEL = "recording:pause";
export const RECORDING_STOP_CHANNEL = "recording:stop";
export const RECORDING_RESUME_CHANNEL = "recording:resume";
export const RECORDING_DISCARD_CHANNEL = "recording:discard";
export const RECORDING_CHANGED_EVENT = "recording:changed";

/** A stream or container name: printable, at most 200 characters. */
const NAME = /^[\x21-\x7e]{1,200}$/;

/** The disk, for the session: a missing scratch file reads as empty; writes are atomic. */
export const diskDeps: Pick<RecordingDeps, "read" | "write" | "copy"> = {
  read: async (file) => readFile(file).catch(() => null),
  write: async (file, bytes) => writeAtomic(file, bytes),
  copy: (from, to) => copyFile(from, to),
};

/** Check Start's message: the window's stream, its containers, whether its host is recorded. */
export function parseTarget(message: unknown, sump: string): RecordingTarget {
  const m = (message ?? {}) as Record<string, unknown>;
  if (typeof m.stream !== "string" || !NAME.test(m.stream)) throw new Error("not a data stream");
  const containers = Array.isArray(m.containers) ? m.containers : [];
  if (containers.length > 200 || !containers.every((c) => typeof c === "string" && NAME.test(c))) {
    throw new Error("containers are up to 200 names");
  }
  return { sump, stream: m.stream, containers: containers as string[], host: m.host === true };
}

/** Answer the channels. `sumpOf` gives the calling window's Sump id. */
export function registerRecordingIpc(
  ipcMain: IpcMainLike,
  session: RecordingSession,
  sumpOf: (event: IpcEventLike) => string | undefined,
): void {
  ipcMain.handle(RECORDING_GET_CHANNEL, () => session.state());
  ipcMain.handle(RECORDING_START_CHANNEL, async (event, message) => {
    if (session.state().status === "paused") return session.start();
    const sump = sumpOf(event);
    if (!sump) return session.state();
    try {
      return await session.start(parseTarget(message, sump));
    } catch {
      return session.start();
    }
  });
  ipcMain.handle(RECORDING_PAUSE_CHANNEL, () => session.pause());
  ipcMain.handle(RECORDING_STOP_CHANNEL, () => session.stop());
  ipcMain.handle(RECORDING_DISCARD_CHANNEL, () => session.discard());
  ipcMain.handle(RECORDING_RESUME_CHANNEL, (_event, from) =>
    from === "interruption" || from === "now" ? session.resume(from) : session.state(),
  );
}

/** The marker's file, written atomically, removed when the session is idle. */
export function markerDeps(file: string): Pick<RecordingDeps, "saveMarker"> {
  return {
    saveMarker: async (marker) => {
      if (marker) writeAtomic(file, `${JSON.stringify(marker, null, 2)}\n`);
      else await rm(file, { force: true });
    },
  };
}

/**
 * The marker left by a previous run, or null; a damaged one is set aside
 * (`.damaged-<time>`) and said through `notify`.
 */
export async function readMarker(
  file: string,
  notify: (text: string) => void,
): Promise<RecordingMarker | null> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  let marker: RecordingMarker | null = null;
  try {
    marker = parseMarker(JSON.parse(text));
  } catch {
    marker = null;
  }
  if (!marker) {
    await rename(file, `${file}.damaged-${Date.now()}`).catch(() => {});
    notify("A previous recording's marker was damaged and set aside");
  }
  return marker;
}
