import { describe, expect, it } from "vitest";
import {
  fieldMenuTemplate,
  MENU_ACTION_CHANNEL,
  MENU_ACTIONS,
  type MenuApp,
  type MenuWindow,
  nativeMenuTemplate,
  registerMenuIpc,
  runMenuAction,
} from "../menu.js";

// REQ-000023-sJpO9KMY Requirements 2 and 4: the menu's actions, the native
// macOS menu and the field menu.

/** A window and an app that record what was done to them. */
function fakes() {
  const done: string[] = [];
  let zoom = 0;
  let full = false;
  const record = (what: string) => () => void done.push(what);
  const window: MenuWindow = {
    webContents: {
      undo: record("undo"),
      redo: record("redo"),
      cut: record("cut"),
      copy: record("copy"),
      paste: record("paste"),
      selectAll: record("selectAll"),
      reload: record("reload"),
      getZoomLevel: () => zoom,
      setZoomLevel: (level) => {
        zoom = level;
        done.push(`zoom ${level}`);
      },
      toggleDevTools: record("devtools"),
    },
    isFullScreen: () => full,
    setFullScreen: (on) => {
      full = on;
      done.push(`fullscreen ${on}`);
    },
    minimize: record("minimize"),
    close: record("close"),
  };
  const app: MenuApp = {
    quit: record("quit"),
    relaunch: record("relaunch"),
    exit: (code) => void done.push(`exit ${code}`),
    showAboutPanel: record("about"),
  };
  return { done, window, app };
}

describe("REQ-000023-sJpO9KMY: the menu's actions", () => {
  it("runs each on the window that asked, or the app", () => {
    const { done, window, app } = fakes();
    for (const action of MENU_ACTIONS) runMenuAction(action, window, app);
    expect(done).toEqual([
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "selectAll",
      "reload",
      "zoom 0.5",
      "zoom 0",
      "zoom 0",
      "fullscreen true",
      "minimize",
      "close",
      "devtools",
      "relaunch",
      "exit 0",
      "quit",
      "about",
    ]);
  });

  it("zooms by half a level each way, and back to 0, as cttc", () => {
    const { done, window, app } = fakes();
    runMenuAction("zoom-in", window, app);
    runMenuAction("zoom-in", window, app);
    runMenuAction("zoom-out", window, app);
    runMenuAction("zoom-reset", window, app);
    expect(done).toEqual(["zoom 0.5", "zoom 1", "zoom 0.5", "zoom 0"]);
  });

  it("still quits without a window, and does nothing to a window that is gone", () => {
    const { done, app } = fakes();
    runMenuAction("quit", null, app);
    runMenuAction("reload", null, app);
    expect(done).toEqual(["quit"]);
  });

  it("refuses a name it does not know, on the bridge too", async () => {
    const { window, app } = fakes();
    expect(() => runMenuAction("exec", window, app)).toThrow(/no menu action "exec"/);
    const handlers = new Map<string, (event: unknown, message: unknown) => unknown>();
    const warned: string[] = [];
    registerMenuIpc({ handle: (c, f) => void handlers.set(c, f as never) }, () => window, app, {
      warn: (m) => warned.push(m),
    });
    const call = handlers.get(MENU_ACTION_CHANNEL) as (e: unknown, m: unknown) => unknown;
    expect(await call({}, "reload")).toEqual({ ok: true });
    expect(await call({}, 42)).toEqual({ ok: false, message: "no menu action 42" });
    expect(warned).toEqual(["menu: no menu action 42"]);
  });
});

describe("REQ-000023-sJpO9KMY: the native menu", () => {
  it("is the app menu and Edit, with their roles, on macOS", () => {
    const menu = nativeMenuTemplate("darwin", "correlate-app");
    expect(menu?.map((m) => m.label)).toEqual(["correlate-app", "Edit"]);
    expect(menu?.[0]?.submenu?.map((i) => i.role ?? i.type)).toEqual([
      "about",
      "separator",
      "hide",
      "hideOthers",
      "unhide",
      "separator",
      "quit",
    ]);
    expect(menu?.[1]?.submenu?.map((i) => i.role ?? i.type)).toEqual([
      "undo",
      "redo",
      "separator",
      "cut",
      "copy",
      "paste",
      "selectAll",
    ]);
  });

  it.each(["win32", "linux"])("is none on %s, as cttc", (platform) => {
    expect(nativeMenuTemplate(platform, "correlate-app")).toBeNull();
  });
});

describe("REQ-000023-sJpO9KMY: the field menu", () => {
  const flags = { canCut: false, canCopy: true, canPaste: true, canSelectAll: true };

  it("offers Cut, Copy, Paste and Select All on an editable field, each enabled only when it can act", () => {
    expect(fieldMenuTemplate({ isEditable: true, editFlags: flags })).toEqual([
      { label: "Cut", role: "cut", enabled: false },
      { label: "Copy", role: "copy", enabled: true },
      { label: "Paste", role: "paste", enabled: true },
      { type: "separator" },
      { label: "Select All", role: "selectAll", enabled: true },
    ]);
  });

  it("offers nothing elsewhere", () => {
    expect(fieldMenuTemplate({ isEditable: false, editFlags: flags })).toBeNull();
  });
});
