/**
 * The live view's settings (REQ-000031-sJpO9KMY Requirement 4, decided in
 * FEAT-000032-sJpO9KMY), cttc's Settings pane: the highlight's time window,
 * live tracking and its offset, and the double-click resume delay; kept in
 * the settings file under `live`, every window told of a change. The limits
 * are `br-VIEW-000002-sJpO9KMY`'s, clamped as cttc's inputs did: the time
 * window at least 1 s, the resume delay never negative, the offset never
 * positive.
 *
 * - `live:get`: the settings.
 * - `live:set` (a part of them): keep it; `live:changed` goes to every window.
 */
import type { IpcMainLike } from "./sump/ipc.js";
import type { Settings } from "./theme.js";

export const LIVE_GET_CHANNEL = "live:get";
export const LIVE_SET_CHANNEL = "live:set";
export const LIVE_CHANGED_EVENT = "live:changed";

const PART = "live";
/** No setting goes past a day, in seconds. */
const MAX_SECS = 86_400;

/** The live view's settings. */
export interface LiveSettings {
  /** Rows this close to the cursor are highlighted, in s (cttc's "Time window"). */
  windowSecs: number;
  /** Live tracking: the cursor follows now while live. */
  liveTrack: boolean;
  /** Where live tracking puts the cursor, relative to now, in s; never positive. */
  liveTrackSecs: number;
  /** After a double-click pause, live again after this many s; 0 stays paused. */
  resumeSecs: number;
}

/** cttc's defaults. */
export const LIVE_DEFAULTS: LiveSettings = {
  windowSecs: 5,
  liveTrack: true,
  liveTrackSecs: 0,
  resumeSecs: 10,
};

/** A number of seconds, clamped to `[lo, hi]`, whole as cttc's inputs (step 1); throws if not a number. */
function secs(value: unknown, lo: number, hi: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${what} is a number`);
  return Math.min(hi, Math.max(lo, Math.round(value)));
}

/** The kept settings, or the defaults for what is missing or damaged. */
export function liveSettings(settings: Settings): LiveSettings {
  const part = settings.part(PART);
  if (typeof part !== "object" || part === null || Array.isArray(part)) return { ...LIVE_DEFAULTS };
  try {
    return apply({ ...LIVE_DEFAULTS }, part);
  } catch {
    return { ...LIVE_DEFAULTS };
  }
}

/** `change` applied to `current`, each value checked and clamped; throws on an unknown key. */
function apply(current: LiveSettings, change: object): LiveSettings {
  const next = { ...current };
  for (const [key, value] of Object.entries(change)) {
    if (key === "windowSecs") next.windowSecs = secs(value, 1, MAX_SECS, key);
    else if (key === "liveTrackSecs") next.liveTrackSecs = secs(value, -MAX_SECS, 0, key);
    else if (key === "resumeSecs") next.resumeSecs = secs(value, 0, MAX_SECS, key);
    else if (key === "liveTrack") {
      if (typeof value !== "boolean") throw new Error("liveTrack is true or false");
      next.liveTrack = value;
    } else throw new Error(`no live setting ${key}`);
  }
  return next;
}

/** Keep `change`; throws on anything but the settings above. */
export function setLiveSettings(settings: Settings, change: unknown): LiveSettings {
  if (typeof change !== "object" || change === null || Array.isArray(change)) {
    throw new Error("a change is an object of live settings");
  }
  const next = apply(liveSettings(settings), change);
  settings.setPart(PART, next);
  return next;
}

/** Answer the two channels; a change is told to every window. */
export function registerLiveIpc(
  ipcMain: IpcMainLike,
  settings: Settings,
  broadcast: (channel: string, value: unknown) => void,
): void {
  ipcMain.handle(LIVE_GET_CHANNEL, () => liveSettings(settings));
  ipcMain.handle(LIVE_SET_CHANNEL, (_event, change) => {
    try {
      const next = setLiveSettings(settings, change);
      broadcast(LIVE_CHANGED_EVENT, next);
      return { ok: true, settings: next };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });
}
