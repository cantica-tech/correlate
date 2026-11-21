"use strict";

/**
 * Preload bridge: the only path between the sandboxed renderer and the main
 * process. It exposes `window.correlate.sump`, the renderer's only way to a
 * Sump (br-CONN-000008-sJpO9KMY): `active()` says which Sump this window is
 * on (br-SUMP-000010-sJpO9KMY), and `request()` names a Sump (by default the
 * window's), a method and a path, never a URL, and resolves to
 * `{ ok: true, value }` or `{ ok: false, error }` (see
 * `main/src/sump/ipc.ts`). Every call is time-bounded in the main process
 * (br-CONN-000005-sJpO9KMY).
 */
const { contextBridge, ipcRenderer } = require("electron");

/** Must match `SUMP_REQUEST_CHANNEL` and `SUMP_ACTIVE_CHANNEL` in `main/src/sump/ipc.ts`. */
const SUMP_REQUEST_CHANNEL = "sump:request";
const SUMP_ACTIVE_CHANNEL = "sump:active";

contextBridge.exposeInMainWorld("correlate", {
  sump: {
    /** This window's active Sump, `{ id, name, kind }`, or null. */
    active: () => ipcRenderer.invoke(SUMP_ACTIVE_CHANNEL),
    /** Send one request to a Sump; resolves to its reply, never rejects. */
    request: (message) => ipcRenderer.invoke(SUMP_REQUEST_CHANNEL, message),
  },
});
