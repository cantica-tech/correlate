/**
 * The Appearance pane's settings, and the status bar's message time
 * (REQ-000050-sJpO9KMY, cttc's `#pane-preferences` and its `prefs` keys):
 * the log highlight, "now" line, live-tracking and recording colors, the
 * "now" line's style, the recording band's sprocket holes, and how long a
 * status-bar message stays. Kept with the app's settings, each value checked;
 * a change is told to every window, which draws with it.
 *
 * - `appearance:get`: the settings, defaults for what is missing or damaged.
 * - `appearance:set` (a change): kept; `appearance:changed` to every window.
 */
import type { IpcMainLike } from "./sump/ipc.js";
import type { Settings } from "./theme.js";

export const APPEARANCE_GET_CHANNEL = "appearance:get";
export const APPEARANCE_SET_CHANNEL = "appearance:set";
export const APPEARANCE_CHANGED_EVENT = "appearance:changed";

const PART = "appearance";

/** The "now" line's styles, as cttc's. */
export const NOW_STYLES = ["dotted", "dashed", "solid"] as const;

/** The settings. */
export interface Appearance {
  hlColor: string;
  nowColor: string;
  nowStyle: (typeof NOW_STYLES)[number];
  liveTrackColor: string;
  recordingColor: string;
  sprockets: boolean;
  /** Seconds a status-bar message stays. */
  statusClearSecs: number;
}

/** cttc's defaults. */
export const APPEARANCE_DEFAULTS: Appearance = {
  hlColor: "#eaff00",
  nowColor: "#14b8a6",
  nowStyle: "dotted",
  liveTrackColor: "#22c55e",
  recordingColor: "#fab219",
  sprockets: true,
  statusClearSecs: 5,
};

const COLOR = /^#[0-9a-fA-F]{6}$/;
const COLORS = ["hlColor", "nowColor", "liveTrackColor", "recordingColor"] as const;

/** `change` applied to `current`, each value checked; throws on a wrong one or an unknown key. */
function apply(current: Appearance, change: object): Appearance {
  const next = { ...current };
  for (const [key, value] of Object.entries(change)) {
    if ((COLORS as readonly string[]).includes(key)) {
      if (typeof value !== "string" || !COLOR.test(value))
        throw new Error(`${key} is a #rrggbb color`);
      next[key as (typeof COLORS)[number]] = value.toLowerCase();
    } else if (key === "nowStyle") {
      if (!NOW_STYLES.includes(value as Appearance["nowStyle"]))
        throw new Error("nowStyle is dotted, dashed or solid");
      next.nowStyle = value as Appearance["nowStyle"];
    } else if (key === "sprockets") {
      if (typeof value !== "boolean") throw new Error("sprockets is true or false");
      next.sprockets = value;
    } else if (key === "statusClearSecs") {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`${key} is a number`);
      next.statusClearSecs = Math.min(3600, Math.max(1, Math.round(value)));
    } else throw new Error(`no appearance setting ${key}`);
  }
  return next;
}

/** The kept settings, or the defaults for what is missing or damaged. */
export function appearance(settings: Settings): Appearance {
  const part = settings.part(PART);
  if (typeof part !== "object" || part === null || Array.isArray(part))
    return { ...APPEARANCE_DEFAULTS };
  try {
    return apply({ ...APPEARANCE_DEFAULTS }, part);
  } catch {
    return { ...APPEARANCE_DEFAULTS };
  }
}

/** Keep `change`; throws on anything but the settings above. */
export function setAppearance(settings: Settings, change: unknown): Appearance {
  if (typeof change !== "object" || change === null || Array.isArray(change))
    throw new Error("a change is an object of appearance settings");
  const next = apply(appearance(settings), change);
  settings.setPart(PART, next);
  return next;
}

/** Answer the two channels; a change is told to every window. */
export function registerAppearanceIpc(
  ipcMain: IpcMainLike,
  settings: Settings,
  broadcast: (channel: string, value: unknown) => void,
): void {
  ipcMain.handle(APPEARANCE_GET_CHANNEL, () => appearance(settings));
  ipcMain.handle(APPEARANCE_SET_CHANNEL, (_event, change) => {
    try {
      const next = setAppearance(settings, change);
      broadcast(APPEARANCE_CHANGED_EVENT, next);
      return { ok: true, appearance: next };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });
}
