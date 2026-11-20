"use strict";

/**
 * Preload bridge: the only path between the sandboxed renderer and the main
 * process. Exposes nothing yet; the Sump API is added with Phase 1 and 4 of
 * `docs/roadmap/correlate-app-rewrite.md`.
 */
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("correlate", {});
