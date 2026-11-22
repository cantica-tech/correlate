/**
 * The Settings pane's main-process side (REQ-000050-sJpO9KMY):
 *
 * - `ownlog:get`: the own log's state (on, folder, this run's file).
 * - `ownlog:set` (true or false): turning it on asks for a folder, as cttc's
 *   (br-DIAG-000001-sJpO9KMY); cancelled, it stays as it was.
 * - `app:hardReset`: after the system's own confirmation, every preference
 *   and the window layout forgotten, then the app relaunched; the Sumps,
 *   keys, projects, recordings and own-log files kept, nothing stopped on
 *   any Sump (decided in FEAT-000052-sJpO9KMY).
 */

import type { OwnLog } from "./ownlog/ownlog.js";
import type { IpcEventLike, IpcMainLike } from "./sump/ipc.js";
import type { Settings } from "./theme.js";

export const OWNLOG_GET_CHANNEL = "ownlog:get";
export const OWNLOG_SET_CHANNEL = "ownlog:set";
export const HARD_RESET_CHANNEL = "app:hardReset";

/** The own log's state, as the pane shows it. */
export interface OwnLogState {
  enabled: boolean;
  dir: string | null;
  current: string | null;
}

/** What the pane's calls need. */
export interface PreferencesDeps {
  ownLog: Pick<OwnLog, "settings" | "set" | "current">;
  settings: Pick<Settings, "reset">;
  /** The folder dialog, starting at `start`: the folder, or null when cancelled. */
  askFolder: (event: IpcEventLike, start: string | null) => Promise<string | null>;
  /** The system's own confirmation of a Hard Reset. */
  confirmReset: (event: IpcEventLike) => Promise<boolean>;
  /** Relaunch the app. */
  relaunch: () => void;
}

function state(ownLog: PreferencesDeps["ownLog"]): OwnLogState {
  const { enabled, dir } = ownLog.settings();
  return { enabled, dir, current: ownLog.current() };
}

/** Turn the own log on (asking where) or off; its state after. */
export async function setOwnLog(
  event: IpcEventLike,
  on: unknown,
  deps: PreferencesDeps,
): Promise<OwnLogState> {
  const settings = deps.ownLog.settings();
  if (on === true) {
    const dir = await deps.askFolder(event, settings.dir);
    if (dir) deps.ownLog.set({ enabled: true, dir });
  } else if (on === false) {
    deps.ownLog.set({ enabled: false, dir: settings.dir });
  }
  return state(deps.ownLog);
}

/** Hard Reset, once confirmed: `{ ok: false }` when not. */
export async function hardReset(
  event: IpcEventLike,
  deps: PreferencesDeps,
): Promise<{ ok: boolean }> {
  if (!(await deps.confirmReset(event))) return { ok: false };
  deps.settings.reset();
  deps.relaunch();
  return { ok: true };
}

/** Answer the pane's channels. */
export function registerPreferencesIpc(ipcMain: IpcMainLike, deps: PreferencesDeps): void {
  ipcMain.handle(OWNLOG_GET_CHANNEL, () => state(deps.ownLog));
  ipcMain.handle(OWNLOG_SET_CHANNEL, (event, on) => setOwnLog(event, on, deps));
  ipcMain.handle(HARD_RESET_CHANNEL, (event) => hardReset(event, deps));
}
