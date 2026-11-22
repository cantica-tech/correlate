/**
 * The application menu's main-process side (REQ-000023-sJpO9KMY
 * Requirements 2 and 4), as cttc's `menubar-action` handler,
 * `installMenu` and `attachEditContextMenu` (`main.js:415-460`):
 *
 * - The menu bar in the window asks for an action by name on `menu:action`;
 *   it runs on the window that asked, or on the app. Only known names run.
 * - On macOS a minimal native menu (the app menu and Edit, with their
 *   standard roles), so ⌘C, ⌘V and the others work in fields and the macOS
 *   menu bar behaves as expected (decided in FEAT-000024-sJpO9KMY); no
 *   native menu elsewhere, as cttc.
 * - A right-click on an editable field opens Cut, Copy, Paste and Select All,
 *   each enabled only when it can act.
 */
import type { IpcMainLike } from "./sump/ipc.js";

/** Every action the menu bar and its shortcuts can ask for. */
export const MENU_ACTIONS = [
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "select-all",
  "reload",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
  "toggle-fullscreen",
  "minimize",
  "close",
  "toggle-devtools",
  "restart",
  "quit",
  "about",
] as const;
export type MenuAction = (typeof MENU_ACTIONS)[number];

/** The IPC channel of the menu bar. */
export const MENU_ACTION_CHANNEL = "menu:action";

/** How much one Zoom In or Zoom Out changes the zoom level, as cttc. */
export const ZOOM_STEP = 0.5;

/** The parts of a window the actions use (Electron's BrowserWindow). */
export interface MenuWindow {
  webContents: {
    undo(): void;
    redo(): void;
    cut(): void;
    copy(): void;
    paste(): void;
    selectAll(): void;
    reload(): void;
    getZoomLevel(): number;
    setZoomLevel(level: number): void;
    toggleDevTools(): void;
  };
  isFullScreen(): boolean;
  setFullScreen(on: boolean): void;
  minimize(): void;
  close(): void;
}

/** The parts of the app the actions use (Electron's app). */
export interface MenuApp {
  quit(): void;
  relaunch(): void;
  exit(code?: number): void;
  showAboutPanel(): void;
}

/** What each action does to the window that asked. */
const ON_WINDOW: Record<
  Exclude<MenuAction, "quit" | "about" | "restart">,
  (w: MenuWindow) => void
> = {
  undo: (w) => w.webContents.undo(),
  redo: (w) => w.webContents.redo(),
  cut: (w) => w.webContents.cut(),
  copy: (w) => w.webContents.copy(),
  paste: (w) => w.webContents.paste(),
  "select-all": (w) => w.webContents.selectAll(),
  reload: (w) => w.webContents.reload(),
  "zoom-in": (w) => w.webContents.setZoomLevel(w.webContents.getZoomLevel() + ZOOM_STEP),
  "zoom-out": (w) => w.webContents.setZoomLevel(w.webContents.getZoomLevel() - ZOOM_STEP),
  "zoom-reset": (w) => w.webContents.setZoomLevel(0),
  "toggle-fullscreen": (w) => w.setFullScreen(!w.isFullScreen()),
  minimize: (w) => w.minimize(),
  close: (w) => w.close(),
  "toggle-devtools": (w) => w.webContents.toggleDevTools(),
};

/** What each action does to the app. */
const ON_APP: Record<"quit" | "about" | "restart", (a: MenuApp) => void> = {
  quit: (a) => a.quit(),
  about: (a) => a.showAboutPanel(),
  restart: (a) => {
    a.relaunch();
    a.exit(0);
  },
};

/** Run one action on `window` (the one that asked) or on the app; throws on an unknown name. */
export function runMenuAction(name: unknown, window: MenuWindow | null, app: MenuApp): void {
  if (!MENU_ACTIONS.includes(name as MenuAction)) {
    throw new Error(`no menu action ${JSON.stringify(name)}`);
  }
  const action = name as MenuAction;
  if (action === "quit" || action === "about" || action === "restart") {
    ON_APP[action](app);
  } else if (window) {
    ON_WINDOW[action](window);
  }
}

/** One item of an Electron menu template, as far as this module writes them. */
export interface MenuItemTemplate {
  label?: string;
  role?: string;
  type?: "separator";
  enabled?: boolean;
  submenu?: MenuItemTemplate[];
  click?: () => void;
}

/**
 * The native menu: on macOS the app menu and Edit, elsewhere none. `about`,
 * when given, is the app's own About (REQ-000051-sJpO9KMY) in place of
 * Electron's panel.
 */
export function nativeMenuTemplate(
  platform: string,
  appName: string,
  about?: () => void,
): MenuItemTemplate[] | null {
  if (platform !== "darwin") return null;
  return [
    {
      label: appName,
      submenu: [
        about ? { label: `About ${appName}`, click: about } : { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
  ];
}

/** What Electron says about a right-click (its `context-menu` event). */
export interface ContextMenuParams {
  isEditable: boolean;
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

/** The field menu for a right-click, or nothing when it is not on an editable field. */
export function fieldMenuTemplate(params: ContextMenuParams): MenuItemTemplate[] | null {
  if (!params.isEditable) return null;
  return [
    { label: "Cut", role: "cut", enabled: params.editFlags.canCut },
    { label: "Copy", role: "copy", enabled: params.editFlags.canCopy },
    { label: "Paste", role: "paste", enabled: params.editFlags.canPaste },
    { type: "separator" },
    { label: "Select All", role: "selectAll", enabled: params.editFlags.canSelectAll },
  ];
}

/**
 * Answer `menu:action`: `windowOf` finds the window that asked. A refused
 * name answers `{ ok: false, message }` and is logged.
 */
export function registerMenuIpc(
  ipcMain: IpcMainLike,
  windowOf: (event: unknown) => MenuWindow | null,
  app: MenuApp,
  logger: { warn(message: string): void } = console,
): void {
  ipcMain.handle(MENU_ACTION_CHANNEL, (event, name) => {
    try {
      runMenuAction(name, windowOf(event), app);
      return { ok: true };
    } catch (error) {
      logger.warn(`menu: ${(error as Error).message}`);
      return { ok: false, message: (error as Error).message };
    }
  });
}
