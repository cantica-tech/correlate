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
const { app, BrowserWindow, ipcMain, Menu, nativeTheme, safeStorage } = require("electron");
const path = require("node:path");
const {
  ActiveSumps,
  Auditor,
  connectSsh,
  defaultSettingsPath,
  fieldMenuTemplate,
  Forwards,
  HealthProbe,
  Lifecycle,
  nativeMenuTemplate,
  Notifications,
  notifyLifecycle,
  SUMP_STATE_EVENT,
  configuredSumps,
  openCatalog,
  openVault,
  registerMenuIpc,
  registerProvisionIpc,
  registerSidebarIpc,
  registerStatusIpc,
  registerSumpIpc,
  registerThemeIpc,
  runCommand,
  reloginWith,
  SessionTokens,
  Settings,
  SidebarHost,
  startForwards,
} = require("./main/dist/main.cjs");

/** Each window's active Sump (br-SUMP-000010); set once the app is ready. */
let activeSumps;
/** The main window, the one the sidebar's actions act on (REQ-000021). */
let mainWindow = null;
/** The sidebar's layout and detached window (REQ-000021); set once the app is ready. */
let sidebar;

/** Sandboxed windows, with the preload bridge as their only link to Node. */
const WEB_PREFERENCES = {
  preload: path.join(__dirname, "preload.cjs"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

/** Send to every window. */
function broadcast(channel, value) {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, value);
}

/**
 * Cut, Copy, Paste and Select All on a right-click in an editable field;
 * Electron gives none by default (REQ-000023, as cttc's attachEditContextMenu).
 */
function attachFieldMenu(window) {
  window.webContents.on("context-menu", (_event, params) => {
    const template = fieldMenuTemplate(params);
    if (template) Menu.buildFromTemplate(template).popup({ window });
  });
}

/** Create the main window. */
function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "correlate-app",
    webPreferences: WEB_PREFERENCES,
  });
  mainWindow = window;
  // Each window has its own active Sump, starting on the last one used.
  const id = window.webContents.id;
  activeSumps?.open(id);
  window.on("closed", () => {
    activeSumps?.close(id);
    if (mainWindow === window) {
      mainWindow = null;
      // The detached sidebar goes with the main window, and stays detached.
      sidebar?.shutDown();
    }
  });
  attachFieldMenu(window);
  window.loadFile(path.join(__dirname, "renderer", "index.html"));
  sidebar?.start();
}

/**
 * The detached sidebar's window (REQ-000021 Requirement 3): the same page,
 * showing only the sidebar; it has no active Sump of its own.
 */
function createSidebarWindow() {
  const window = new BrowserWindow({
    width: 260,
    height: 680,
    title: "correlate-app Sidebar",
    webPreferences: WEB_PREFERENCES,
  });
  attachFieldMenu(window);
  window.loadFile(path.join(__dirname, "renderer", "index.html"), { query: { view: "sidebar" } });
  return {
    close: () => {
      if (!window.isDestroyed()) window.close();
    },
    focus: () => window.focus(),
    onClosed: (listener) => window.on("closed", listener),
  };
}

app.whenReady().then(() => {
  // The theme first, so no window paints in the wrong one (REQ-000018).
  const settings = new Settings(defaultSettingsPath(process.env));
  nativeTheme.themeSource = settings.themeMode();
  // cttc's menu bar is drawn in the window; on macOS a minimal native menu
  // (app menu and Edit) keeps the system shortcuts working (REQ-000023).
  const nativeMenu = nativeMenuTemplate(process.platform, app.name);
  Menu.setApplicationMenu(nativeMenu ? Menu.buildFromTemplate(nativeMenu) : null);
  registerMenuIpc(ipcMain, (event) => BrowserWindow.fromWebContents(event.sender), app);
  registerThemeIpc(ipcMain, settings, (mode) => {
    nativeTheme.themeSource = mode;
  });
  // The sidebar's layout, shared by the main window and the detached one;
  // About and Quit run here, every other action in the main window.
  sidebar = new SidebarHost(
    settings,
    {
      broadcast,
      sendToMain: (channel, value) => mainWindow?.webContents.send(channel, value),
      openDetached: createSidebarWindow,
    },
    {
      quit: () => app.quit(),
      about: () => app.showAboutPanel(),
    },
  );
  registerSidebarIpc(ipcMain, sidebar);
  app.on("before-quit", () => sidebar.shutDown());
  // Session tokens live in memory only: quitting forgets them (br-CONN-000004).
  // A refused token is renewed by logging in with the vault's SSH key
  // (br-CONN-000007).
  const tokens = new SessionTokens();
  const vault = openVault(app.getPath("userData"), safeStorage);
  // The instance catalog, ~/.correlate/catalog.db; a corrupt one is left
  // untouched and the app runs without it (br-SUMP-000001).
  const catalog = openCatalog(process.env);
  activeSumps = new ActiveSumps(catalog);
  // Every Sump's lifecycle state, held here only; windows are told of each
  // change and can only read it (br-SUMP-000011).
  const lifecycle = new Lifecycle(catalog);
  // Remote Sumps are reached only through their SSH forward, each kept up in
  // the background (br-SUMP-000008, -000009, -000010).
  const forwards = new Forwards({ lifecycle });
  const sumps = configuredSumps(process.env, tokens, catalog, forwards);
  startForwards(forwards, catalog, vault);
  lifecycle.subscribe((record) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(SUMP_STATE_EVENT, record);
    }
  });
  // After each successful connect, the other Sumps are audited in the
  // background; nothing is switched or added (br-SUMP-000005).
  const auditor = catalog
    ? new Auditor({ catalog, vault, forwards, connect: connectSsh })
    : undefined;
  const afterConnect = () => auditor?.soon();
  const relogin = reloginWith(vault, sumps, tokens, process.env, catalog, lifecycle, afterConnect);
  registerSumpIpc(ipcMain, sumps, tokens, relogin, activeSumps, lifecycle);
  // Notifications and their History, one feed for every window; a Sump a
  // window is on that is lost or comes back is notified (REQ-000022).
  const notifications = new Notifications();
  notifyLifecycle(
    lifecycle,
    notifications,
    (id) => activeSumps.windowsOn(id).length > 0,
    (id) => catalog?.get(id)?.name ?? id,
  );
  registerStatusIpc(ipcMain, notifications, settings, broadcast);
  // A Sump a window is on is probed every 5 s, the others every 30 s.
  const probe = new HealthProbe(lifecycle, sumps, { inUse: () => activeSumps.inUse() });
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
    resolve: sumps,
    forwards,
    afterConnect,
    audit: auditor ? () => auditor.run() : undefined,
    // Recordings plug in with Phase 8; until then none is ever live.
    guard: { liveRecording: () => undefined },
  });
  // The passphrase's derived key lives only for the session.
  app.on("will-quit", () => {
    probe.stop();
    forwards.stopAll();
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
