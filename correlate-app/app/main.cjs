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
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage } = require("electron");
const path = require("node:path");
const {
  ActiveStreams,
  ActiveSumps,
  Auditor,
  connectSsh,
  defaultSettingsPath,
  fieldMenuTemplate,
  fileRequest,
  handleSumpRequest,
  Forwards,
  HealthProbe,
  Lifecycle,
  nativeMenuTemplate,
  Notifications,
  notifyLifecycle,
  SUMP_STATE_EVENT,
  configuredSumps,
  OPENED_EXTENSIONS,
  OpenFiles,
  Projects,
  openCatalog,
  openVault,
  registerMenuIpc,
  registerAnalysisIpc,
  registerLiveIpc,
  registerLogsIpc,
  registerPickerIpc,
  registerProjectIpc,
  registerSeriesIpc,
  registerProvisionIpc,
  registerSidebarIpc,
  registerStreamIpc,
  registerStatusIpc,
  registerSumpIpc,
  registerThemeIpc,
  runCommand,
  reloginWith,
  SessionTokens,
  shownTracks,
  Settings,
  SidebarHost,
  startForwards,
} = require("./main/dist/main.cjs");

/** Each window's active Sump (br-SUMP-000010); set once the app is ready. */
let activeSumps;
/** Each window's active data stream (REQ-000027). */
const activeStreams = new ActiveStreams();
/** Each window's open file, in the analysis view (REQ-033). */
const openFiles = new OpenFiles();
/** Each window's project (REQ-035); set once the app is ready. */
let projectsReady = null;
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
  // A project with unsaved changes is asked about before the window goes (REQ-035).
  let closing = false;
  window.on("close", (event) => {
    if (closing || !projectsReady?.dirty(id)) return;
    event.preventDefault();
    const name = projectsReady.view(id).name;
    void dialog
      .showMessageBox(window, {
        type: "question",
        buttons: ["Save", "Discard", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        message: `Save the changes to the project ${name}?`,
        detail: "Discarded changes are lost.",
      })
      .then(async ({ response }) => {
        if (response === 2) return;
        if (response === 0 && !projectsReady.save(id)) {
          const r = await dialog.showSaveDialog(window, {
            title: "Save Project As",
            defaultPath: `${name}.correlator`,
            filters: [{ name: "Projects", extensions: ["correlator"] }],
          });
          if (r.canceled || !r.filePath) return;
          projectsReady.saveAs(id, r.filePath);
        }
        closing = true;
        window.close();
      });
  });
  window.on("closed", () => {
    activeSumps?.close(id);
    activeStreams.close(id);
    openFiles.close(id);
    projectsReady?.close(id);
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
  // The data-stream picker opens on the stream last edited on each Sump (REQ-000026).
  registerPickerIpc(ipcMain, settings);
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
  // Each window's active data stream, on its active Sump (REQ-000027).
  registerStreamIpc(ipcMain, activeStreams, activeSumps);
  // Each stream's containers: their order and those hidden (REQ-000030).
  registerSeriesIpc(ipcMain, settings, activeSumps);
  // The log panels' order and lanes, and Export .log: the save dialog
  // first, then the rows through the window's Sump (REQ-000029).
  registerLogsIpc(ipcMain, settings, {
    ask: async (event, defaultName) => {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options = {
        title: "Export .log",
        defaultPath: defaultName,
        filters: [{ name: "Log", extensions: ["log"] }],
      };
      const r = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    // In the analysis view, Export reads the window's open file (REQ-033).
    request: async (event, message) =>
      message.file
        ? fileRequest(openFiles, event.sender.id, message)
        : handleSumpRequest(
            message,
            sumps,
            tokens,
            relogin,
            activeSumps.get(event.sender.id),
            lifecycle,
          ),
  });
  // The analysis view: a cttc file opened read-only, its data answered here,
  // never sent to a Sump (REQ-033).
  // Projects (REQ-035): each window's, the default beside the settings; its
  // files shown through the analysis view's open files (REQ-033, REQ-034),
  // read by this process and never sent to a Sump.
  const projects = new Projects(path.dirname(defaultSettingsPath(process.env)), settings);
  registerAnalysisIpc(ipcMain, openFiles, (window) => {
    const { tracks } = shownTracks(projects, openFiles, window);
    return Object.fromEntries(Object.entries(tracks).map(([name, t]) => [name, t.delaySecs]));
  });
  const windowOfEvent = (event) => BrowserWindow.fromWebContents(event.sender) ?? undefined;
  registerProjectIpc(ipcMain, projects, openFiles, {
    askProject: async (event) => {
      const options = {
        title: "Open Project",
        properties: ["openFile"],
        filters: [{ name: "Projects", extensions: ["correlator"] }],
      };
      const window = windowOfEvent(event);
      const r = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
    },
    askSaveAs: async (event, suggested) => {
      const options = {
        title: "Save Project As",
        defaultPath: suggested,
        filters: [{ name: "Projects", extensions: ["correlator"] }],
      };
      const window = windowOfEvent(event);
      const r = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    askFiles: async (event) => {
      const options = {
        title: "Add Files",
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "cttc recordings and metrics", extensions: OPENED_EXTENSIONS }],
      };
      const window = windowOfEvent(event);
      const r = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      return r.canceled ? [] : r.filePaths;
    },
  });
  projectsReady = projects;
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
  // The live view's settings, every window told of a change (REQ-000031).
  registerLiveIpc(ipcMain, settings, broadcast);
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
