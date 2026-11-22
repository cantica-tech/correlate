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
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  safeStorage,
} = require("electron");
const path = require("node:path");
const {
  ActiveStreams,
  addFiles,
  ActiveSumps,
  Auditor,
  connectSsh,
  defaultSettingsPath,
  diskDeps,
  markerDeps,
  fieldMenuTemplate,
  filesFromArgv,
  fileRequest,
  handleSumpRequest,
  Forwards,
  HealthProbe,
  Inbox,
  Lifecycle,
  nativeMenuTemplate,
  Notifications,
  notifyLifecycle,
  SUMP_STATE_EVENT,
  configuredSumps,
  OPEN_FILES_EVENT,
  OPENED_EXTENSIONS,
  OpenFiles,
  Projects,
  RECORDING_CHANGED_EVENT,
  RecordingSession,
  readMarker,
  openCatalog,
  openVault,
  registerMenuIpc,
  registerOpenIpc,
  registerAnalysisIpc,
  registerLiveIpc,
  registerLogsIpc,
  registerPickerIpc,
  registerExportIpc,
  registerRecordingIpc,
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
  writeAtomic,
  logPrefs,
  FiringsFollower,
  registerEventsIpc,
  EVENTS_FIRED_EVENT,
  stream,
  download,
  OwnLog,
  parseOwnLogSettings,
  besideTheApp,
  captureConsole,
  windowError,
  followLocalSump,
  dockerFollow,
  registerShipIpc,
  fetchSumpLog,
  registerAppearanceIpc,
  registerPreferencesIpc,
  readBuildInfo,
  sumpAbout,
  aboutText,
  request,
  registerPromoteIpc,
  identityPublicKey,
  joinCatalog,
  PROMOTE_TIMEOUT_MS,
} = require("./main/dist/main.cjs");

/** Each window's active Sump (br-SUMP-000010); set once the app is ready. */
let activeSumps;
/** Each window's active data stream (REQ-000027). */
const activeStreams = new ActiveStreams();
/** Each window's open file, in the analysis view (REQ-033). */
const openFiles = new OpenFiles();
/** Each window's project (REQ-035); set once the app is ready. */
let projectsReady = null;

// Files the OS hands the app (REQ-036): the app runs once; a second launch
// passes its files here and quits; macOS sends them as `open-file`, even
// before the app is ready. They wait for the main window, in order.
const inbox = new Inbox((arrived) => mainWindow?.webContents.send(OPEN_FILES_EVENT, arrived));
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, workingDirectory) => {
    inbox.push(filesFromArgv(argv, workingDirectory, Boolean(process.defaultApp)));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
app.on("open-file", (event, file) => {
  event.preventDefault();
  inbox.push(filesFromArgv(["app", file], "/", false));
});
inbox.push(filesFromArgv(process.argv, process.cwd(), Boolean(process.defaultApp)));
/** The main window, the one the sidebar's actions act on (REQ-000021). */
let mainWindow = null;
/** The Sumps by id, with their tokens, for About (set once the catalog is open). */
let aboutSumps = null;
/** The app's own log (REQ-048), from the start of `whenReady`. */
let ownLog = null;
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
  // A window's uncaught errors go to the own log too (REQ-048).
  window.webContents.on("console-message", (event) => {
    const line = windowError(event);
    if (line) ownLog?.write("ERROR", line);
  });
  window.webContents.on("context-menu", (_event, params) => {
    const template = fieldMenuTemplate(params);
    if (template) Menu.buildFromTemplate(template).popup({ window });
  });
}

/**
 * About (REQ-051): the build (its stamp, or a development build with the
 * checkout's commit), the stack, and the main window's Sump (its version and
 * plugins, or why not), in the system's own message box with OK and Copy.
 */
async function showAbout() {
  const build = readBuildInfo(app.getAppPath(), app.getVersion());
  const stack = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  };
  let sump = null;
  const id = mainWindow ? activeSumps?.get(mainWindow.webContents.id) : undefined;
  const target = id && aboutSumps ? aboutSumps(id) : undefined;
  if (target) {
    try {
      const health = await request(target, "GET", "/health", { timeoutMs: 5_000 });
      const plugins = await request(target, "GET", "/plugins", { timeoutMs: 5_000 }).catch(
        () => null,
      );
      sump = sumpAbout(target.name, health, plugins);
    } catch (error) {
      sump = { name: target.name, error: error.message };
    }
  }
  const text = aboutText(build, stack, sump, new Date().getFullYear());
  const options = {
    type: "info",
    title: `About ${app.name}`,
    message: app.name,
    detail: text,
    buttons: ["OK", "Copy"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (response === 1) clipboard.writeText(`${app.name}\n${text}`);
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
  // A new window takes the files waiting for it (REQ-036).
  inbox.reset();
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
  // The own log, on by default next to the app, falling back once to the
  // data folder (br-DIAG-000001); everything the console says, and the local
  // Sump's container log, classified (br-DIAG-000003, REQ-048).
  ownLog = new OwnLog({
    read: () => parseOwnLogSettings(settings.part("ownLog")),
    write: (value) => settings.setPart("ownLog", value),
    defaultDir: app.isPackaged
      ? besideTheApp(process.execPath, process.platform)
      : app.getAppPath(),
    fallbackDir: app.getPath("userData"),
    warn: (text) => console.warn(text),
  });
  ownLog.start();
  captureConsole(ownLog);
  const stopSumpLog = followLocalSump(ownLog, dockerFollow);
  app.on("will-quit", () => stopSumpLog());
  nativeTheme.themeSource = settings.themeMode();
  // cttc's menu bar is drawn in the window; on macOS a minimal native menu
  // (app menu and Edit) keeps the system shortcuts working (REQ-000023).
  const nativeMenu = nativeMenuTemplate(process.platform, app.name, () => void showAbout());
  Menu.setApplicationMenu(nativeMenu ? Menu.buildFromTemplate(nativeMenu) : null);
  // The menus' About is the app's own (REQ-051), not Electron's panel.
  const menuApp = {
    quit: () => app.quit(),
    relaunch: () => app.relaunch(),
    exit: (code) => app.exit(code),
    showAboutPanel: () => void showAbout(),
  };
  registerMenuIpc(ipcMain, (event) => BrowserWindow.fromWebContents(event.sender), menuApp);
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
      about: () => void showAbout(),
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
  aboutSumps = sumps;
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
  // A live recording is abandoned only once the user confirms
  // (br-REC-000001, REQ-000039): the session below answers.
  const recordingGuard = {
    liveRecording: () => recording.live(),
    abandon: () => recording.discard(),
  };
  // Each window's active data stream, on its active Sump (REQ-000027).
  registerStreamIpc(ipcMain, activeStreams, activeSumps, recordingGuard);
  registerOpenIpc(ipcMain, inbox);
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
  // The Appearance pane's colors and styles, and the status bar's message time (REQ-050).
  registerAppearanceIpc(ipcMain, settings, broadcast);
  // The Settings pane: the own log's switch (asking for a folder) and Hard
  // Reset, confirmed by the system, preferences only (REQ-050).
  registerPreferencesIpc(ipcMain, {
    ownLog,
    settings,
    askFolder: async (event, start) => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
      const options = {
        title: "Choose a folder for correlate-app's own logs",
        defaultPath: start ?? undefined,
        properties: ["openDirectory", "createDirectory"],
      };
      const r = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    },
    confirmReset: async (event) => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
      const options = {
        type: "warning",
        buttons: ["Cancel", "Hard Reset"],
        defaultId: 0,
        cancelId: 0,
        message: "Hard Reset",
        detail:
          "This erases every correlate-app preference on this machine (theme, colors, live settings, window layout, recent projects) and relaunches the app. Your Sumps, keys, projects, recordings and log files are kept. This cannot be undone.",
      };
      const r = owner
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options);
      return r.response === 1;
    },
    relaunch: () => {
      app.relaunch();
      app.exit(0);
    },
  });
  // The recording session (REQ-037): one for the app; its segments come from
  // the Sump it started on, saved where the user chooses, joining the project.
  const dataDir = path.dirname(defaultSettingsPath(process.env));
  const recording = new RecordingSession({
    scratch: path.join(dataDir, "recording-in-progress.recording"),
    fetchSegment: (sump, query) =>
      handleSumpRequest(
        { sump, method: "GET", path: "/records/segment", query },
        sumps,
        tokens,
        relogin,
        undefined,
        lifecycle,
      ),
    ...diskDeps,
    // The marker follows the session for crash recovery (REQ-038).
    ...markerDeps(path.join(dataDir, "recording-marker.json")),
    askSave: async (suggested) => {
      const id = mainWindow?.webContents.id;
      const file = id === undefined ? null : projects.view(id).file;
      const options = {
        title: "Save Recording",
        defaultPath: path.join(file ? path.dirname(file) : dataDir, suggested),
        filters: [{ name: "Recordings", extensions: ["recording"] }],
      };
      const r = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    addToProject: (file) => {
      if (mainWindow) projects.change(mainWindow.webContents.id, (p) => addFiles(p, [file]));
    },
    notify: (text) => notifications.add(text),
    changed: (state) => broadcast(RECORDING_CHANGED_EVENT, state),
  });
  registerRecordingIpc(ipcMain, recording, (event) => activeSumps.get(event.sender.id));
  // Captures and snapshots (REQ-041): the destination asked first, then the
  // window's Sump or its shown file read, written atomically.
  const askSaveIn = async (event, options) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const file = projects.view(event.sender.id).file;
    const defaultPath = path.join(file ? path.dirname(file) : dataDir, options.name);
    const r = owner
      ? await dialog.showSaveDialog(owner, { ...options, defaultPath })
      : await dialog.showSaveDialog({ ...options, defaultPath });
    return r.canceled || !r.filePath ? null : r.filePath;
  };
  registerExportIpc(ipcMain, {
    capture: (event) => ({
      askSave: (name) =>
        askSaveIn(event, {
          title: "Save Capture",
          name,
          filters: [{ name: "Recordings", extensions: ["recording"] }],
        }),
      fetchSegment: (query) => {
        const sump = activeSumps.get(event.sender.id);
        if (!sump)
          return Promise.resolve({ ok: false, error: { message: "this window has no Sump" } });
        return handleSumpRequest(
          { sump, method: "GET", path: "/records/segment", query },
          sumps,
          tokens,
          relogin,
          undefined,
          lifecycle,
        );
      },
      shownFile: () => openFiles.get(event.sender.id),
      write: (file, bytes) => writeAtomic(file, bytes),
    }),
    // The shown file's export (REQ-042): its containers not hidden in the
    // legend, its host when the host block is open, its tracks' delays.
    metrics: (event) => ({
      scope: () => {
        const window = event.sender.id;
        const file = openFiles.get(window);
        if (!file) return undefined;
        const { tracks } = shownTracks(projects, openFiles, window);
        return {
          file,
          containers: file.containers.filter((name) => !tracks[name]?.hidden),
          host: logPrefs(settings).hostOpen,
          delays: Object.fromEntries(
            Object.entries(tracks).map(([name, t]) => [name, t.delaySecs ?? 0]),
          ),
        };
      },
      askSave: (name, format) =>
        askSaveIn(event, {
          title: "Export Metrics",
          name,
          filters: [
            format === "json"
              ? { name: "JSON", extensions: ["json"] }
              : { name: "Text", extensions: ["txt"] },
          ],
        }),
      write: (file, content) => writeAtomic(file, content),
    }),
    askSaveSnapshot: (event, name, kind) =>
      askSaveIn(event, {
        title: "Save Snapshot",
        name,
        filters: [
          kind === "json"
            ? { name: "JSON", extensions: ["json"] }
            : { name: "Text", extensions: ["txt"] },
        ],
      }),
    write: (file, content) => writeAtomic(file, content),
  });
  recording.startTicking();
  // A recording interrupted by a crash comes back paused, its choice offered
  // to the main window; its Sump known only if still in the catalog (REQ-038).
  void readMarker(path.join(dataDir, "recording-marker.json"), (text) =>
    notifications.add(text),
  ).then((marker) => {
    if (marker)
      recording.recover(
        marker,
        Boolean(catalog?.get(marker.target.sump) ?? marker.target.sump === "local"),
      );
  });
  // A Sump a window is on is probed every 5 s, the others every 30 s.
  const probe = new HealthProbe(lifecycle, sumps, { inUse: () => activeSumps.inUse() });
  probe.start();
  // Startup plan and provisioning, for the Add Sump screens (REQ-000014).
  const remoteCtx = {
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
    guard: recordingGuard,
  };
  registerProvisionIpc(ipcMain, remoteCtx);
  // Promote… (REQ-052): the window's Sump promotes a stream; the secondary
  // joins the catalog through this app's own first connect.
  registerPromoteIpc(ipcMain, (event) => ({
    sump: () => {
      const id = activeSumps.get(event.sender.id);
      return id ? sumps(id) : undefined;
    },
    publicKey: () => {
      if (vault.state === "none" && !vault.needsPassphrase()) vault.create();
      if (vault.state !== "unlocked") throw new Error("the key vault is locked");
      return identityPublicKey(vault);
    },
    post: (sump, path, body) =>
      request(sump, "POST", path, { body, timeoutMs: PROMOTE_TIMEOUT_MS }),
    join: (secondary) => joinCatalog(remoteCtx, secondary),
  }));
  // The passphrase's derived key lives only for the session.
  // Events' firings, from every Sump the app is logged in to (REQ-046, D7):
  // said in the status bar and its history, told to the windows.
  const firings = new FiringsFollower({
    sumps: () => tokens.sumps(),
    resolve: (id) => sumps(id),
    name: (id) => catalog?.get(id)?.name ?? id,
    open: (sump, streamPath, onEvent, options) => stream(sump, streamPath, onEvent, options),
    notify: (text) => notifications.add(text),
    told: (firing) => broadcast(EVENTS_FIRED_EVENT, firing),
  });
  firings.start();
  // An event's artifact, saved where the user chooses, checked before it is
  // written (REQ-046, cttc bug 26).
  registerEventsIpc(ipcMain, {
    askSave: (event, suggested) =>
      askSaveIn(event, {
        title: "Save Event Artifact",
        name: suggested,
        filters: [{ name: "Recordings", extensions: ["recording"] }],
      }),
    bytes: async (event, artifact) => {
      const id = activeSumps.get(event.sender.id);
      const sump = id ? sumps(id) : undefined;
      if (!sump) throw new Error("this window has no Sump");
      const chunks = [];
      await download(sump, `/artifacts/${artifact}`, (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      return Buffer.concat(chunks);
    },
    write: (file, bytes) => writeAtomic(file, bytes),
  });
  // Ship Logs (REQ-049): the own log's files and the window's Sump's log,
  // asked where first, the local files erased only on a yes.
  registerShipIpc(ipcMain, (event) => ({
    dir: () => {
      const current = ownLog.current();
      return current ? path.dirname(current) : ownLog.settings().dir;
    },
    current: () => ownLog.current(),
    sumpLog: () => {
      const id = activeSumps.get(event.sender.id);
      return fetchSumpLog(id ? sumps(id) : undefined, download);
    },
    askSave: (name) =>
      askSaveIn(event, {
        title: "Ship Logs",
        name,
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
      }),
    confirmErase: async (count) => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
      const options = {
        type: "question",
        buttons: ["Keep them", `Erase ${count} local log files`],
        defaultId: 0,
        cancelId: 0,
        message: "The logs are shipped.",
        detail: "Erase the local log files now in the zip? The file this run writes is kept.",
      };
      const r = owner
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options);
      return r.response === 1;
    },
    write: (file, bytes) => writeAtomic(file, bytes),
  }));
  app.on("will-quit", () => {
    firings.stopAll();
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
