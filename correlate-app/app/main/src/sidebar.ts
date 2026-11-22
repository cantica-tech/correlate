/**
 * The sidebar's layout and its detached window (REQ-000021-sJpO9KMY
 * Requirements 2 to 4), in the main process so the main window and the
 * detached one share it.
 *
 * The layout (where the sidebar docks, where it last docked, its width,
 * whether it is a rail, which sections are open) is kept in the settings
 * file under `sidebar`, beside the theme. Every change is checked, saved and
 * sent to every window. Docking to `detached` opens the sidebar in a window
 * of its own; docking back, or closing that window, closes it and docks the
 * sidebar where it was, as cttc's `setDock` and `redockActionBar` did
 * (cttc `app.js:4435-4450`). The detached window's entries act on the main
 * window: its actions are forwarded there by name, and only known names.
 */

import type { IpcMainLike } from "./sump/ipc.js";
import type { Settings } from "./theme.js";

/** Where the sidebar sits. */
export type Dock = "left" | "right" | "detached";
/** Where a docked sidebar sits. */
export type DockedSide = "left" | "right";

/** The sidebar's sections (FEAT-000022-sJpO9KMY). */
export const SECTIONS = ["sump", "projects", "events"] as const;
export type Section = (typeof SECTIONS)[number];

/** Every action an entry of the sidebar can ask for. */
export const SIDEBAR_ACTIONS = [
  "new-sump",
  "edit-sump",
  "uninstall-sump",
  "new-data-stream",
  "edit-data-streams",
  "close-data-streams",
  "remove-data-stream",
  "new-project",
  "open-project",
  "add-files",
  "create-event",
  "edit-events",
  "preferences",
  "about",
  "quit",
] as const;
export type SidebarAction = (typeof SIDEBAR_ACTIONS)[number];

/** The sidebar's width bounds and default, as cttc's (`app.js:4500`). */
export const MIN_WIDTH = 120;
export const MAX_WIDTH = 480;
export const DEFAULT_WIDTH = 210;

/** The sidebar's layout. */
export interface SidebarLayout {
  dock: Dock;
  lastDock: DockedSide;
  width: number;
  collapsed: boolean;
  expanded: Record<Section, boolean>;
}

/** Docked left, 210 px, open, every section closed: cttc's defaults. */
export function defaultLayout(): SidebarLayout {
  return {
    dock: "left",
    lastDock: "left",
    width: DEFAULT_WIDTH,
    collapsed: false,
    expanded: { sump: false, projects: false, events: false },
  };
}

/** The IPC channels of the sidebar. */
export const SIDEBAR_GET_CHANNEL = "sidebar:get";
export const SIDEBAR_SET_CHANNEL = "sidebar:set";
export const SIDEBAR_ACTION_CHANNEL = "sidebar:action";
/** Sent to every window after each change of the layout. */
export const SIDEBAR_LAYOUT_EVENT = "sidebar:layout";
/** Sent to the main window: run this action. */
export const SIDEBAR_RUN_EVENT = "sidebar:run";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Check a change to the layout: only known keys, each with a value in range.
 * Throws, saying what is wrong, on anything else.
 */
export function checkChange(change: unknown): Partial<SidebarLayout> {
  if (!isObject(change)) throw new Error("a layout change is an object");
  const out: Partial<SidebarLayout> = {};
  for (const [key, value] of Object.entries(change)) {
    switch (key) {
      case "dock":
        if (value !== "left" && value !== "right" && value !== "detached")
          throw new Error("dock is left, right or detached");
        out.dock = value;
        break;
      case "lastDock":
        if (value !== "left" && value !== "right") throw new Error("lastDock is left or right");
        out.lastDock = value;
        break;
      case "width":
        if (
          !Number.isInteger(value) ||
          (value as number) < MIN_WIDTH ||
          (value as number) > MAX_WIDTH
        )
          throw new Error(`width is a whole number from ${MIN_WIDTH} to ${MAX_WIDTH}`);
        out.width = value as number;
        break;
      case "collapsed":
        if (typeof value !== "boolean") throw new Error("collapsed is true or false");
        out.collapsed = value;
        break;
      case "expanded": {
        if (!isObject(value)) throw new Error("expanded maps sections to true or false");
        const expanded: Partial<Record<Section, boolean>> = {};
        for (const [section, open] of Object.entries(value)) {
          if (!SECTIONS.includes(section as Section)) throw new Error(`no section ${section}`);
          if (typeof open !== "boolean") throw new Error(`expanded.${section} is true or false`);
          expanded[section as Section] = open;
        }
        out.expanded = expanded as Record<Section, boolean>;
        break;
      }
      default:
        throw new Error(`no layout setting ${key}`);
    }
  }
  return out;
}

/** Apply a checked change; the last dock follows a docked dock. */
function merge(layout: SidebarLayout, change: Partial<SidebarLayout>): SidebarLayout {
  const next: SidebarLayout = {
    ...layout,
    ...change,
    expanded: { ...layout.expanded, ...(change.expanded ?? {}) },
  };
  if (change.dock && change.dock !== "detached") next.lastDock = change.dock;
  return next;
}

/** The saved layout, every value checked; a bad one is logged and left at its default. */
export function readLayout(
  settings: Settings,
  logger: { warn(message: string): void } = console,
): SidebarLayout {
  const saved = settings.part("sidebar");
  let layout = defaultLayout();
  if (saved === undefined) return layout;
  if (!isObject(saved)) {
    logger.warn("settings: the sidebar layout is not an object; using the defaults");
    return layout;
  }
  for (const [key, value] of Object.entries(saved)) {
    try {
      layout = merge(layout, checkChange({ [key]: value }));
    } catch (error) {
      logger.warn(`settings: sidebar ${(error as Error).message}; using the default`);
    }
  }
  // A saved dock and last dock are read as they are, not one from the other.
  if (saved.lastDock === "left" || saved.lastDock === "right") layout.lastDock = saved.lastDock;
  return layout;
}

/** The detached sidebar's window, as far as the host needs it. */
export interface DetachedWindow {
  close(): void;
  focus(): void;
  /** Called once the window has closed, whoever closed it. */
  onClosed(listener: () => void): void;
}

/** What the host does with windows; main.cjs gives it Electron's. */
export interface SidebarWindows {
  /** Send to every window. */
  broadcast(channel: string, value: unknown): void;
  /** Send to the main window, if it is open. */
  sendToMain(channel: string, value: unknown): void;
  /** Open the detached sidebar's window. */
  openDetached(): DetachedWindow;
}

/** Actions the main process runs itself rather than the main window. */
export interface MainActions {
  quit(): void;
  about(): void;
}

/** Keeps the layout, the detached window and the forwarding of actions. */
export class SidebarHost {
  private current: SidebarLayout;
  private detached: DetachedWindow | undefined;
  /** While true, a closing detached window does not dock the sidebar back. */
  private closing = false;

  constructor(
    private readonly settings: Settings,
    private readonly windows: SidebarWindows,
    private readonly actions: MainActions,
    private readonly logger: { info(message: string): void; warn(message: string): void } = console,
  ) {
    this.current = readLayout(settings, logger);
  }

  /** The layout now. */
  layout(): SidebarLayout {
    return structuredClone(this.current);
  }

  /** Open the detached window if the sidebar was left detached; call once the main window is up. */
  start(): void {
    this.syncWindow();
  }

  /** Check, apply, save and send a change; returns the new layout. Throws when refused. */
  set(change: unknown): SidebarLayout {
    const checked = checkChange(change);
    this.current = merge(this.current, checked);
    this.settings.setPart("sidebar", this.current);
    this.syncWindow(checked.dock === "detached");
    this.windows.broadcast(SIDEBAR_LAYOUT_EVENT, this.layout());
    return this.layout();
  }

  /** Run a known action: quit and about here, everything else in the main window. */
  action(name: unknown): void {
    if (!SIDEBAR_ACTIONS.includes(name as SidebarAction)) {
      throw new Error(`no sidebar action ${JSON.stringify(name)}`);
    }
    if (name === "quit") this.actions.quit();
    else if (name === "about") this.actions.about();
    else this.windows.sendToMain(SIDEBAR_RUN_EVENT, name);
  }

  /**
   * The app is quitting, or the main window closing: close the detached
   * window without docking the sidebar back, so it opens detached next time.
   */
  shutDown(): void {
    this.closing = true;
    try {
      this.detached?.close();
    } finally {
      this.detached = undefined;
      this.closing = false;
    }
  }

  /** Open or close the detached window to match the dock; `focus` raises an open one. */
  private syncWindow(focus = false): void {
    if (this.current.dock === "detached") {
      if (this.detached) {
        if (focus) this.detached.focus();
        return;
      }
      const window = this.windows.openDetached();
      this.detached = window;
      window.onClosed(() => {
        if (this.detached !== window) return;
        this.detached = undefined;
        // Closed by the user: dock it back where it was.
        if (!this.closing && this.current.dock === "detached") {
          this.logger.info("sidebar: detached window closed; docking it back");
          this.set({ dock: this.current.lastDock });
        }
      });
    } else if (this.detached) {
      const window = this.detached;
      this.detached = undefined;
      window.close();
    }
  }
}

/**
 * Answer the sidebar's bridge: `sidebar:get`, `sidebar:set` (a refused
 * change answers `{ ok: false, message }`) and `sidebar:action`.
 */
export function registerSidebarIpc(ipcMain: IpcMainLike, host: SidebarHost): void {
  ipcMain.handle(SIDEBAR_GET_CHANNEL, () => host.layout());
  ipcMain.handle(SIDEBAR_SET_CHANNEL, (_event, change) => {
    try {
      return { ok: true, layout: host.set(change) };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });
  ipcMain.handle(SIDEBAR_ACTION_CHANNEL, (_event, name) => {
    try {
      host.action(name);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });
}
