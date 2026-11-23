"use strict";

/**
 * Preload bridge: the only path between the sandboxed renderer and the main
 * process. It exposes `window.correlate.theme` (`get()`, `set()`: the theme
 * choice, REQ-000018-sJpO9KMY) and `window.correlate.sump`, the renderer's only way to a
 * Sump (br-CONN-000008-sJpO9KMY): `active()` says which Sump this window is
 * on (br-SUMP-000010-sJpO9KMY), `states()` and `onState()` read the Sumps'
 * lifecycle states, never set them (br-SUMP-000011-sJpO9KMY), `plan()` and
 * `provisionLocal()`/`provisionRemote()` drive the Add Sump flow
 * (REQ-000014-sJpO9KMY), `list()`, `rename()`, `replaceKey()`, `switchTo()`
 * and `uninstall()` manage Sumps (REQ-000015-sJpO9KMY), `audit()` checks
 * them (REQ-000017-sJpO9KMY), and
 * `request()` names a Sump (by default the window's), a method and a path,
 * never a URL, and resolves to
 * `{ ok: true, value }` or `{ ok: false, error }` (see
 * `main/src/sump/ipc.ts`). Every call is time-bounded in the main process
 * (br-CONN-000005-sJpO9KMY). `window.correlate.sidebar` reads and changes the
 * sidebar's layout, shared by every window, and asks for its actions by name
 * (REQ-000021-sJpO9KMY). `window.correlate.status` reads and adds to the
 * notifications' History and shows or hides the status bar
 * (REQ-000022-sJpO9KMY). `window.correlate.menu.action()` runs a menu bar
 * entry by name on this window (REQ-000023-sJpO9KMY).
 * `window.correlate.picker` remembers the data-stream picker's last stream
 * per Sump (REQ-000026-sJpO9KMY). `window.correlate.stream` reads and sets
 * this window's active data stream (REQ-000027-sJpO9KMY). `window.correlate.logs`
 * keeps the log panels' choices and runs Export .log (REQ-000029-sJpO9KMY);
 * `window.correlate.series` keeps each stream's containers' order and hidden
 * set (REQ-000030-sJpO9KMY); `window.correlate.live` the live view's
 * settings (REQ-000031-sJpO9KMY); `window.correlate.analysis` the analysis
 * view's open files, read by the main process (REQ-000033-sJpO9KMY);
 * `window.correlate.project` the window's project (REQ-000035-sJpO9KMY);
 * `window.correlate.opened` the files the OS hands the app (REQ-000036-sJpO9KMY);
 * `window.correlate.recording` the recording session (REQ-000037-sJpO9KMY).
 * `window.correlate.exports` captures and snapshots (REQ-000041-sJpO9KMY).
 * `window.correlate.events` event artifacts' downloads and firings (REQ-000046-sJpO9KMY).
 */
const { contextBridge, ipcRenderer } = require("electron");

/** Must match the channels in `main/src/sump/ipc.ts`. */
const SUMP_REQUEST_CHANNEL = "sump:request";
const SUMP_ACTIVE_CHANNEL = "sump:active";
const SUMP_STATES_CHANNEL = "sump:states";
const SUMP_STATE_EVENT = "sump:state";
/** Must match the channels in `main/src/provision/ipc.ts`. */
const PLAN_CHANNEL = "sump:plan";
const PROVISION_LOCAL_CHANNEL = "sump:provisionLocal";
const PROVISION_REMOTE_CHANNEL = "sump:provisionRemote";
const LIST_CHANNEL = "sump:list";
const RENAME_CHANNEL = "sump:rename";
const REPLACE_KEY_CHANNEL = "sump:replaceKey";
const SWITCH_CHANNEL = "sump:switch";
const UNINSTALL_CHANNEL = "sump:uninstall";
const AUDIT_CHANNEL = "sump:audit";
/** Must match the channels in `main/src/theme.ts`. */
const THEME_GET_CHANNEL = "theme:get";
const THEME_SET_CHANNEL = "theme:set";
/** Must match the channels in `main/src/sidebar.ts`. */
const SIDEBAR_GET_CHANNEL = "sidebar:get";
const SIDEBAR_SET_CHANNEL = "sidebar:set";
const SIDEBAR_ACTION_CHANNEL = "sidebar:action";
const SIDEBAR_LAYOUT_EVENT = "sidebar:layout";
const SIDEBAR_RUN_EVENT = "sidebar:run";
/** Must match the channels in `main/src/notify.ts`. */
const STATUS_HISTORY_CHANNEL = "status:history";
const STATUS_ADD_CHANNEL = "status:add";
const STATUS_CLEAR_CHANNEL = "status:clear";
const STATUS_VISIBLE_CHANNEL = "status:visible";
const STATUS_SET_VISIBLE_CHANNEL = "status:setVisible";
const STATUS_NOTICE_EVENT = "status:notice";
const STATUS_VISIBILITY_EVENT = "status:visibility";
/** Must match the channel in `main/src/menu.ts`. */
const MENU_ACTION_CHANNEL = "menu:action";
/** Must match the channels in `main/src/picker.ts`. */
const PICKER_LAST_CHANNEL = "picker:lastStream";
const PICKER_SET_LAST_CHANNEL = "picker:setLastStream";
/** Must match the channels in `main/src/analysis/ipc.ts`. */
const ANALYSIS_LIST_CHANNEL = "analysis:list";
const ANALYSIS_REQUEST_CHANNEL = "analysis:request";
const ANALYSIS_CLOSE_CHANNEL = "analysis:close";
/** Must match the channels in `main/src/projects/ipc.ts`. */
const PROJECT_CHANNELS = {
  get: "project:get",
  newProject: "project:new",
  open: "project:open",
  openFile: "project:openFile",
  save: "project:save",
  saveAs: "project:saveAs",
  addFiles: "project:addFiles",
  addPaths: "project:addPaths",
  importCttc: "project:importCttc",
  show: "project:show",
  change: "project:change",
  tracks: "project:tracks",
};
/** Must match the channels in `main/src/opened.ts`. */
const OPEN_TAKE_CHANNEL = "open:take";
const OPEN_FILES_EVENT = "open:files";
/** Must match the channels in `main/src/exports/ipc.ts`. */
const EXPORT_CAPTURE_CHANNEL = "export:capture";
const EXPORT_SAVE_SNAPSHOT_CHANNEL = "export:saveSnapshot";
const EXPORT_METRICS_CHANNEL = "export:metrics";
/** Must match the channels in `main/src/events/ipc.ts`. */
const EVENTS_DOWNLOAD_CHANNEL = "events:download";
const EVENTS_FIRED_EVENT = "events:fired";
/** Must match the channels in `main/src/recording/ipc.ts`. */
const RECORDING_CHANNELS = {
  get: "recording:get",
  start: "recording:start",
  pause: "recording:pause",
  stop: "recording:stop",
  resume: "recording:resume",
  discard: "recording:discard",
  changed: "recording:changed",
};
/** Must match the channels in `main/src/live.ts`. */
const LIVE_GET_CHANNEL = "live:get";
const LIVE_SET_CHANNEL = "live:set";
const LIVE_CHANGED_EVENT = "live:changed";
/** Must match the channels in `main/src/series.ts`. */
const SERIES_GET_CHANNEL = "series:get";
const SERIES_SET_CHANNEL = "series:set";
/** Must match the channels in `main/src/logs.ts`. */
const LOGS_PREFS_CHANNEL = "logs:prefs";
const LOGS_SET_PREFS_CHANNEL = "logs:setPrefs";
const LOGS_EXPORT_CHANNEL = "logs:export";
const LOGS_SHIP_CHANNEL = "logs:ship";
/** Must match the channels in `main/src/streams.ts`. */
const STREAM_ACTIVE_CHANNEL = "stream:active";
const STREAM_SET_ACTIVE_CHANNEL = "stream:setActive";
const STREAM_PROMOTE_CHANNEL = "streams:promote";

/** Listen on `channel`; returns the function that stops listening. */
function listen(channel, listener) {
  const handler = (_event, value) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("correlate", {
  theme: {
    /** The theme choice: "system", "light" or "dark". */
    get: () => ipcRenderer.invoke(THEME_GET_CHANNEL),
    /** Change the theme everywhere, remembered across runs (REQ-000018-sJpO9KMY). */
    set: (mode) => ipcRenderer.invoke(THEME_SET_CHANNEL, mode),
  },
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
    /** What the Add Sump flow offers: `{ firstRun, docker, offers }`. */
    plan: () => ipcRenderer.invoke(PLAN_CHANNEL),
    /** Provision a Sump here; `{ switchTo: true }` moves this window to it once connected. */
    provisionLocal: (options) => ipcRenderer.invoke(PROVISION_LOCAL_CHANNEL, options),
    /** Provision a Sump on a host over SSH: `{ sshTarget, sshPort, sumpPort, name, keyPem }`. */
    provisionRemote: (details) => ipcRenderer.invoke(PROVISION_REMOTE_CHANNEL, details),
    /** The live Sumps, with their state and whether this window is on one. */
    list: () => ipcRenderer.invoke(LIST_CHANNEL),
    /** Rename a Sump: `{ id, name }`. */
    rename: (change) => ipcRenderer.invoke(RENAME_CHANNEL, change),
    /** Give a remote Sump a new SSH key, proven by a login first: `{ id, keyPem }`. */
    replaceKey: (change) => ipcRenderer.invoke(REPLACE_KEY_CHANNEL, change),
    /** Move this window to a Sump that answers: `{ id, confirmed }`. */
    switchTo: (target) => ipcRenderer.invoke(SWITCH_CHANNEL, target),
    /** Uninstall a Sump, everything removed, once `{ id, confirmed: true }`. */
    uninstall: (target) => ipcRenderer.invoke(UNINSTALL_CHANNEL, target),
    /** Audit every known Sump now: `{ ok, results: [{ id, existence, ... }] }`. */
    audit: () => ipcRenderer.invoke(AUDIT_CHANNEL),
    /** Send one request to a Sump; resolves to its reply, never rejects. */
    request: (message) => ipcRenderer.invoke(SUMP_REQUEST_CHANNEL, message),
  },
  sidebar: {
    /** The sidebar's layout: `{ dock, lastDock, width, collapsed, expanded }`. */
    get: () => ipcRenderer.invoke(SIDEBAR_GET_CHANNEL),
    /** Change part of it, for every window: `{ ok, layout }` or `{ ok: false, message }`. */
    set: (change) => ipcRenderer.invoke(SIDEBAR_SET_CHANNEL, change),
    /** Ask for an entry's action by name; it runs in the main window. */
    action: (name) => ipcRenderer.invoke(SIDEBAR_ACTION_CHANNEL, name),
    /** Hear each change of the layout; returns the function that stops listening. */
    onLayout: (listener) => listen(SIDEBAR_LAYOUT_EVENT, listener),
    /** Hear the actions this window should run; returns the function that stops listening. */
    onRun: (listener) => listen(SIDEBAR_RUN_EVENT, listener),
  },
  status: {
    /** Every notification, oldest first: `[{ at, text }]`. */
    history: () => ipcRenderer.invoke(STATUS_HISTORY_CHANNEL),
    /** Add a message (plain text, at most 500 characters). */
    add: (text) => ipcRenderer.invoke(STATUS_ADD_CHANNEL, text),
    /** Forget every notification, for every window. */
    clear: () => ipcRenderer.invoke(STATUS_CLEAR_CHANNEL),
    /** Whether the status bar is shown. */
    visible: () => ipcRenderer.invoke(STATUS_VISIBLE_CHANNEL),
    /** Show or hide the status bar, remembered. */
    setVisible: (visible) => ipcRenderer.invoke(STATUS_SET_VISIBLE_CHANNEL, visible),
    /** Hear each new notification and each clear; returns the function that stops listening. */
    onNotice: (listener) => listen(STATUS_NOTICE_EVENT, listener),
    /** Hear the bar shown or hidden; returns the function that stops listening. */
    onVisibility: (listener) => listen(STATUS_VISIBILITY_EVENT, listener),
  },
  menu: {
    /** Run a menu bar entry by name ("reload", "zoom-in", "copy", ...) on this window. */
    action: (name) => ipcRenderer.invoke(MENU_ACTION_CHANNEL, name),
  },
  picker: {
    /** The stream last submitted in the data-stream picker on Sump `sump`, or null. */
    lastStream: (sump) => ipcRenderer.invoke(PICKER_LAST_CHANNEL, sump),
    /** Remember `{ sump, stream }` as the last stream submitted on that Sump. */
    setLastStream: (choice) => ipcRenderer.invoke(PICKER_SET_LAST_CHANNEL, choice),
  },
  stream: {
    /** This window's active data stream on its Sump, or null. */
    active: () => ipcRenderer.invoke(STREAM_ACTIVE_CHANNEL),
    /**
     * Make a stream this window's active one: `{ ok, stream }` or `{ ok: false, message }`;
     * `{ ok: false, step: "confirm" }` while a recording is live, unless `confirmed`.
     */
    setActive: (stream, confirmed) =>
      ipcRenderer.invoke(
        STREAM_SET_ACTIVE_CHANNEL,
        confirmed === true ? { stream, confirmed: true } : stream,
      ),
    /**
     * Promote an SSH stream to a secondary Sump on its host (REQ-000052):
     * `{ ok, secondary, catalog }` or `{ ok: false, message }`.
     */
    promote: (stream) => ipcRenderer.invoke(STREAM_PROMOTE_CHANNEL, { stream }),
  },
  analysis: {
    /** This window's open files and the shown one. */
    list: () => ipcRenderer.invoke(ANALYSIS_LIST_CHANNEL),
    /** One of the views' queries, answered from this window's open file. */
    request: (message) => ipcRenderer.invoke(ANALYSIS_REQUEST_CHANNEL, message),
    /** Back to live: the files stay open. */
    close: () => ipcRenderer.invoke(ANALYSIS_CLOSE_CHANNEL),
  },
  project: {
    /** This window's project, its missing files, its open list, and Recent. */
    get: () => ipcRenderer.invoke(PROJECT_CHANNELS.get),
    /** A new project, not saved yet. */
    newProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.newProject),
    /** Open a project file (the open dialog). */
    open: () => ipcRenderer.invoke(PROJECT_CHANNELS.open),
    /** Open a Recent project. */
    openFile: (file) => ipcRenderer.invoke(PROJECT_CHANNELS.openFile, file),
    /** Save the project (Save As when it has no file yet). */
    save: () => ipcRenderer.invoke(PROJECT_CHANNELS.save),
    /** Save the project as a new file (the save dialog). */
    saveAs: () => ipcRenderer.invoke(PROJECT_CHANNELS.saveAs),
    /** Add cttc files to the project (the open dialog); the last is shown. */
    addFiles: () => ipcRenderer.invoke(PROJECT_CHANNELS.addFiles),
    /** Add captures the OS handed the app (no dialog); the last is shown. */
    addPaths: (paths) => ipcRenderer.invoke(PROJECT_CHANNELS.addPaths, paths),
    /** Import cttc's files as correlate-app's (the open dialog), then add and show them. */
    importCttc: () => ipcRenderer.invoke(PROJECT_CHANNELS.importCttc),
    /** Show one of the project's files, by id. */
    show: (id) => ipcRenderer.invoke(PROJECT_CHANNELS.show, id),
    /** Change the project: `{ op, ... }`. */
    change: (change) => ipcRenderer.invoke(PROJECT_CHANNELS.change, change),
    /** The shown file's tracks: `{ item, tracks }`. */
    tracks: () => ipcRenderer.invoke(PROJECT_CHANNELS.tracks),
  },
  exports: {
    /** Save `{ view, stream, containers, host, from, to }` as a `.recording`, where the user chooses. */
    capture: (request) => ipcRenderer.invoke(EXPORT_CAPTURE_CHANNEL, request),
    /** Save a snapshot `{ name, content, kind: "txt" | "json" }`, where the user chooses. */
    saveSnapshot: (snapshot) => ipcRenderer.invoke(EXPORT_SAVE_SNAPSHOT_CHANNEL, snapshot),
    /** Export the shown file `{ stats, logs, format, detail }`, where the user chooses (REQ-000042). */
    metrics: (request) => ipcRenderer.invoke(EXPORT_METRICS_CHANNEL, request),
  },
  events: {
    /** Save an artifact `{ artifact, name, size }` of the window's Sump, where the user chooses. */
    download: (artifact) => ipcRenderer.invoke(EVENTS_DOWNLOAD_CHANNEL, artifact),
    /** Called with each firing as the main process hears it; returns an unsubscribe. */
    onFired: (callback) => {
      const listener = (_event, firing) => callback(firing);
      ipcRenderer.on(EVENTS_FIRED_EVENT, listener);
      return () => ipcRenderer.removeListener(EVENTS_FIRED_EVENT, listener);
    },
  },
  recording: {
    /** The recording session's state. */
    get: () => ipcRenderer.invoke(RECORDING_CHANNELS.get),
    /** Start recording `{ stream, containers, host }` on this window's Sump, or resume. */
    start: (target) => ipcRenderer.invoke(RECORDING_CHANNELS.start, target),
    /** Pause: the segment saved to the scratch recording. */
    pause: () => ipcRenderer.invoke(RECORDING_CHANNELS.pause),
    /** Stop: then the save dialog. */
    stop: () => ipcRenderer.invoke(RECORDING_CHANNELS.stop),
    /** After a crash: resume from `"interruption"` or `"now"`. */
    resume: (from) => ipcRenderer.invoke(RECORDING_CHANNELS.resume, from),
    /** Abandon the recording, once the user confirmed (REQ-000039-sJpO9KMY). */
    discard: () => ipcRenderer.invoke(RECORDING_CHANNELS.discard),
    /** Hear the session change; returns the function that stops listening. */
    onChanged: (listener) => listen(RECORDING_CHANNELS.changed, listener),
  },
  opened: {
    /** The window is ready: the files the OS handed the app so far, and those ignored. */
    take: () => ipcRenderer.invoke(OPEN_TAKE_CHANNEL),
    /** Hear files handed later; returns the function that stops listening. */
    onFiles: (listener) => listen(OPEN_FILES_EVENT, listener),
  },
  live: {
    /** The live view's settings: windowSecs, liveTrack, liveTrackSecs, resumeSecs. */
    get: () => ipcRenderer.invoke(LIVE_GET_CHANNEL),
    /** Keep a part of them. */
    set: (change) => ipcRenderer.invoke(LIVE_SET_CHANNEL, change),
    /** Hear them change; returns the function that stops listening. */
    onChanged: (listener) => listen(LIVE_CHANGED_EVENT, listener),
  },
  appearance: {
    /** The Appearance pane's colors and styles, and the status bar's message time (REQ-000050). */
    get: () => ipcRenderer.invoke("appearance:get"),
    /** Keep a part of them. */
    set: (change) => ipcRenderer.invoke("appearance:set", change),
    /** Hear them change; returns the function that stops listening. */
    onChanged: (listener) => listen("appearance:changed", listener),
  },
  preferences: {
    /** The own log's `{ enabled, dir, current }`. */
    ownLog: () => ipcRenderer.invoke("ownlog:get"),
    /** Turn it on (asking for a folder) or off; its state after. */
    setOwnLog: (on) => ipcRenderer.invoke("ownlog:set", on),
    /** Hard Reset, after the system's confirmation: preferences only, then a relaunch. */
    hardReset: () => ipcRenderer.invoke("app:hardReset"),
  },
  series: {
    /** A stream's containers' `{ order, hidden }` on this window's Sump. */
    get: (stream) => ipcRenderer.invoke(SERIES_GET_CHANNEL, stream),
    /** Keep `{ stream, order, hidden }`. */
    set: (arrangement) => ipcRenderer.invoke(SERIES_SET_CHANNEL, arrangement),
  },
  logs: {
    /** The log panels' order and whether the lanes are open. */
    prefs: () => ipcRenderer.invoke(LOGS_PREFS_CHANNEL),
    /** Remember `{ order }` or `{ lanesOpen }`. */
    setPrefs: (change) => ipcRenderer.invoke(LOGS_SET_PREFS_CHANNEL, change),
    /** Export .log `{ source, name, from, to, order }`: asks for the file first. */
    exportLog: (request) => ipcRenderer.invoke(LOGS_EXPORT_CHANNEL, request),
    /** Ship Logs: the local log files and the Sump's in one zip, asked where first (REQ-000049). */
    ship: () => ipcRenderer.invoke(LOGS_SHIP_CHANNEL),
  },
});
