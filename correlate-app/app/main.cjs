"use strict";

/**
 * Electron main process for correlate-app.
 *
 * Opens the main window on the renderer bundle (`renderer/dist/bundle.js`,
 * built by `build/build-renderer.js`) and answers the renderer's Sump
 * requests through the Sump client (`main/dist/main.cjs`, built from
 * `main/src/` by `build/build-main.js`; br-CONN-000008-sJpO9KMY). It opens the
 * key vault and locks it when the app quits (br-VAULT-000004-sJpO9KMY), and the
 * instance catalog, giving each window its own active Sump
 * (br-SUMP-000001-sJpO9KMY, br-SUMP-000010-sJpO9KMY). The window
 * shell and menus come with Phase 4 of
 * `docs/roadmap/correlate-app-rewrite.md`. CommonJS, as in cttc and
 * correlator, because Electron's own module loads most reliably this way.
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const {
  ActiveSumps,
  HealthProbe,
  Lifecycle,
  SUMP_STATE_EVENT,
  configuredSumps,
  openCatalog,
  openVault,
  registerProvisionIpc,
  registerSumpIpc,
  runCommand,
  reloginWith,
  SessionTokens,
} = require("./main/dist/main.cjs");

/** Each window's active Sump (br-SUMP-000010); set once the app is ready. */
let activeSumps;

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
  // Each window has its own active Sump, starting on the last one used.
  const id = window.webContents.id;
  activeSumps?.open(id);
  window.on("closed", () => activeSumps?.close(id));
  window.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  // Session tokens live in memory only: quitting forgets them (br-CONN-000004).
  // A refused token is renewed by logging in with the vault's SSH key
  // (br-CONN-000007).
  const tokens = new SessionTokens();
  const vault = openVault(app.getPath("userData"), safeStorage);
  // The instance catalog, ~/.correlate/catalog.db; a corrupt one is left
  // untouched and the app runs without it (br-SUMP-000001).
  const catalog = openCatalog(process.env);
  activeSumps = new ActiveSumps(catalog);
  const sumps = configuredSumps(process.env, tokens, catalog);
  // Every Sump's lifecycle state, held here only; windows are told of each
  // change and can only read it (br-SUMP-000011).
  const lifecycle = new Lifecycle(catalog);
  lifecycle.subscribe((record) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(SUMP_STATE_EVENT, record);
    }
  });
  const relogin = reloginWith(vault, sumps, tokens, process.env, catalog, lifecycle);
  registerSumpIpc(ipcMain, sumps, tokens, relogin, activeSumps, lifecycle);
  const probe = new HealthProbe(lifecycle, sumps);
  probe.start();
  // Startup plan and provisioning, for the Add Sump screens (REQ-000014).
  registerProvisionIpc(ipcMain, {
    run: runCommand,
    lifecycle,
    tokens,
    vault,
    env: process.env,
    appVersion: app.getVersion(),
    catalog,
    active: activeSumps,
    pending: new Map(),
  });
  // The passphrase's derived key lives only for the session.
  app.on("will-quit", () => {
    probe.stop();
    vault?.lock();
    catalog?.close();
  });
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
