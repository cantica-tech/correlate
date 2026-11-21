"use strict";

/**
 * Electron main process for correlate-app.
 *
 * Opens the main window on the renderer bundle (`renderer/dist/bundle.js`,
 * built by `build/build-renderer.js`) and answers the renderer's Sump
 * requests through the Sump client (`main/dist/main.cjs`, built from
 * `main/src/` by `build/build-main.js`; br-CONN-000008-sJpO9KMY). It opens the
 * key vault and locks it when the app quits (br-VAULT-000004-sJpO9KMY). The window
 * shell and menus come with Phase 4 of
 * `docs/roadmap/correlate-app-rewrite.md`. CommonJS, as in cttc and
 * correlator, because Electron's own module loads most reliably this way.
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const {
  configuredSumps,
  openVault,
  registerSumpIpc,
  reloginWith,
  SessionTokens,
} = require("./main/dist/main.cjs");

/** Create the main window, sandboxed, with the preload bridge as its only link to Node. */
function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "correlate-app",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  // Session tokens live in memory only: quitting forgets them (br-CONN-000004).
  // A refused token is renewed by logging in with the vault's SSH key
  // (br-CONN-000007).
  const tokens = new SessionTokens();
  const vault = openVault(app.getPath("userData"), safeStorage);
  const sumps = configuredSumps(process.env, tokens);
  registerSumpIpc(ipcMain, sumps, tokens, reloginWith(vault, sumps, tokens, process.env));
  // The passphrase's derived key lives only for the session.
  app.on("will-quit", () => vault?.lock());
  createWindow();
  // macOS: re-open a window when the dock icon is clicked and none is open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when every window is closed, except on macOS, where apps stay active.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
