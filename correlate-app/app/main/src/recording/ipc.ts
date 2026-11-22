/**
 * The recording session for the windows (REQ-000037-sJpO9KMY): one session
 * for the app, told to every window as it changes.
 *
 * - `recording:get`: its state.
 * - `recording:start` (`{ stream, containers, host }`, the window's active
 *   stream): start on the window's Sump, or resume.
 * - `recording:pause`, `recording:stop`.
 * - `recording:changed` (to every window): the new state.
 */
import { copyFile, readFile } from "node:fs/promises";
import { writeAtomic } from "../projects/store.js";
import type { IpcEventLike, IpcMainLike } from "../sump/ipc.js";
import type { RecordingDeps, RecordingSession, RecordingTarget } from "./session.js";

export const RECORDING_GET_CHANNEL = "recording:get";
export const RECORDING_START_CHANNEL = "recording:start";
export const RECORDING_PAUSE_CHANNEL = "recording:pause";
export const RECORDING_STOP_CHANNEL = "recording:stop";
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
}
