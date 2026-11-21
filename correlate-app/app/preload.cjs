"use strict";

/**
 * Preload bridge: the only path between the sandboxed renderer and the main
 * process. It exposes one thing, `window.correlate.sump.request`, the
 * renderer's only way to a Sump (br-CONN-000008-sJpO9KMY): it names a Sump,
 * a method and a path, never a URL, and resolves to
 * `{ ok: true, value }` or `{ ok: false, error }` (see
 * `main/src/sump/ipc.ts`). Every call is time-bounded in the main process
 * (br-CONN-000005-sJpO9KMY).
 */
const { contextBridge, ipcRenderer } = require("electron");

/** Must match `SUMP_REQUEST_CHANNEL` in `main/src/sump/ipc.ts`. */
const SUMP_REQUEST_CHANNEL = "sump:request";

contextBridge.exposeInMainWorld("correlate", {
  sump: {
    /** Send one request to a Sump; resolves to its reply, never rejects. */
    request: (message) => ipcRenderer.invoke(SUMP_REQUEST_CHANNEL, message),
  },
});
