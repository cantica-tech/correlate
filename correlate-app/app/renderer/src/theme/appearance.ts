/**
 * The Appearance pane's settings, as the window draws with them
 * (REQ-000050-sJpO9KMY): cttc's `hlColor`, `nowLineColor`, `nowLineStyle`,
 * `liveTrackColor`, `recordingBandColor`, `recordingSprocketHoles` and
 * `statusBarClearSecs`. One store per window: the Shell fills it from the
 * main process and its changes; the canvases and the status bar read it and
 * redraw when it changes. The log highlight and live-tracking colors are CSS
 * variables too, as cttc's (`--hl-color`, `--live-track-color`).
 */
import { useSyncExternalStore } from "react";
import type { Appearance } from "../shell/bridge.js";

/** cttc's defaults, as the main process's. */
export const APPEARANCE_DEFAULTS: Appearance = {
  hlColor: "#eaff00",
  nowColor: "#14b8a6",
  nowStyle: "dotted",
  liveTrackColor: "#22c55e",
  recordingColor: "#fab219",
  sprockets: true,
  statusClearSecs: 5,
};

let current: Appearance = APPEARANCE_DEFAULTS;
const listeners = new Set<() => void>();

/** The window's appearance now. */
export function appearance(): Appearance {
  return current;
}

/** Draw with `next` from now on: the CSS variables set, every reader told. */
export function setAppearance(next: Appearance): void {
  current = next;
  if (typeof document !== "undefined") {
    const style = document.documentElement.style;
    style.setProperty("--hl-color", next.hlColor);
    style.setProperty("--live-track-color", next.liveTrackColor);
  }
  for (const listener of listeners) listener();
}

/** The appearance, re-rendering the component when it changes. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    appearance,
    appearance,
  );
}
