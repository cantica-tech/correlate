"use strict";

/**
 * Preload bridge: the only path between the sandboxed renderer and the main
 * process. It exposes `window.correlate.sump`, the renderer's only way to a
 * Sump (br-CONN-000008-sJpO9KMY): `active()` says which Sump this window is
 * on (br-SUMP-000010-sJpO9KMY), `states()` and `onState()` read the Sumps'
 * lifecycle states, never set them (br-SUMP-000011-sJpO9KMY), and
 * `request()` names a Sump (by default the window's), a method and a path,
 * never a URL, and resolves to
 * `{ ok: true, value }` or `{ ok: false, error }` (see
 * `main/src/sump/ipc.ts`). Every call is time-bounded in the main process
 * (br-CONN-000005-sJpO9KMY).
 */
const { contextBridge, ipcRenderer } = require("electron");

/** Must match the channels in `main/src/sump/ipc.ts`. */
const SUMP_REQUEST_CHANNEL = "sump:request";
const SUMP_ACTIVE_CHANNEL = "sump:active";
const SUMP_STATES_CHANNEL = "sump:states";
const SUMP_STATE_EVENT = "sump:state";

contextBridge.exposeInMainWorld("correlate", {
  sump: {
    /** This window's active Sump, `{ id, name, kind }`, or null. */
    active: () => ipcRenderer.invoke(SUMP_ACTIVE_CHANNEL),
    /** Every Sump's lifecycle state (br-SUMP-000011-sJpO9KMY); read-only. */
    states: () => ipcRenderer.invoke(SUMP_STATES_CHANNEL),
    /** Hear each lifecycle change; returns the function that stops listening. */
    onState: (listener) => {
      const handler = (_event, record) => listener(record);
      ipcRenderer.on(SUMP_STATE_EVENT, handler);
      return () => ipcRenderer.removeListener(SUMP_STATE_EVENT, handler);
    },
    /** Send one request to a Sump; resolves to its reply, never rejects. */
    request: (message) => ipcRenderer.invoke(SUMP_REQUEST_CHANNEL, message),
  },
});
