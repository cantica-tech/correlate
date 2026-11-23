/**
 * What the menu bar holds (REQ-000023-sJpO9KMY Requirement 1), cttc's
 * File, Edit, View, Window and Help (`index.html:15-73`), with
 * correlate-app's File entries (projects in place of metrics files) and
 * without cttc's Redis CLI. Shortcuts are written cttc's way, "Ctrl+...",
 * and shown "⌘" on macOS, as cttc's labels were.
 */
import type { IconName } from "../icons/icons.generated.js";

/** One entry. */
export interface MenuItem {
  action: string;
  label: string;
  /** Its shortcut, cttc's way ("Ctrl+Z"). */
  acc?: string;
  /** An icon before the label, as cttc's File entries. */
  icon?: IconName;
  /** Not built yet: shown disabled, saying so. */
  later?: boolean;
  title?: string;
  /** Indented under a sub-label, as cttc's Developers entries. */
  indent?: boolean;
}

/** A separator, or a small uppercase sub-label. */
export type MenuLine = MenuItem | "separator" | { subLabel: string };

/** One menu. */
export interface Menu {
  id: string;
  label: string;
  items: readonly MenuLine[];
}

/**
 * The File menu's project (REQ-000035-sJpO9KMY), recording
 * (REQ-000037-sJpO9KMY) and export (REQ-000042-sJpO9KMY) entries, run by the
 * window, not the main process.
 */
export const PROJECT_ACTIONS: readonly string[] = [
  "new-project",
  "open-project",
  "save-project",
  "save-project-as",
  "add-files",
  "import-cttc",
  "start-recording",
  "pause-recording",
  "stop-recording",
  "export-metrics",
  "ship-logs",
];

export const MENUS: readonly Menu[] = [
  {
    id: "file",
    label: "File",
    items: [
      {
        action: "new-project",
        label: "New Project",
        icon: "new",
        title: "Start a correlation project",
      },
      {
        action: "open-project",
        label: "Open Project…",
        acc: "Ctrl+O",
        icon: "load-data",
        title: "Open a saved project",
      },
      {
        action: "save-project",
        label: "Save Project",
        acc: "Ctrl+S",
        title: "Save the project to its file",
      },
      {
        action: "save-project-as",
        label: "Save Project As…",
        acc: "Ctrl+Shift+S",
        title: "Save the project as a new file",
      },
      {
        action: "add-files",
        label: "Add Files…",
        icon: "opened-data",
        title: "Add cttc recordings or metrics to the project",
      },
      {
        action: "import-cttc",
        label: "Import cttc Files…",
        icon: "load-data",
        title:
          "Write cttc's recordings and metrics as correlate-app files beside them; the originals are not changed",
      },
      "separator",
      {
        action: "start-recording",
        label: "Start or Resume Recording",
        title: "Record the active data stream, or resume a paused recording",
      },
      {
        action: "pause-recording",
        label: "Pause Recording",
        title: "End this segment; Start resumes with a new one",
      },
      {
        action: "stop-recording",
        label: "Stop Recording…",
        title: "Finish the recording and choose where to save it",
      },
      "separator",
      {
        action: "export-metrics",
        label: "Export Metrics…",
        icon: "export",
        title: "Export the shown file's stats/logs as text or JSON",
      },
      {
        action: "ship-logs",
        label: "Ship Logs…",
        title: "Zip this app's logs and the Sump's, to send when something went wrong",
      },
      "separator",
      { action: "restart", label: "Restart" },
      "separator",
      { action: "quit", label: "Quit", acc: "Ctrl+Q" },
    ],
  },
  {
    id: "edit",
    label: "Edit",
    items: [
      { action: "undo", label: "Undo", acc: "Ctrl+Z" },
      { action: "redo", label: "Redo", acc: "Ctrl+Shift+Z" },
      "separator",
      { action: "cut", label: "Cut", acc: "Ctrl+X" },
      { action: "copy", label: "Copy", acc: "Ctrl+C" },
      { action: "paste", label: "Paste", acc: "Ctrl+V" },
      { action: "select-all", label: "Select All", acc: "Ctrl+A" },
    ],
  },
  {
    id: "view",
    label: "View",
    items: [
      { action: "reload", label: "Reload", acc: "Ctrl+R" },
      "separator",
      { action: "zoom-in", label: "Zoom In", acc: "Ctrl+=" },
      { action: "zoom-out", label: "Zoom Out", acc: "Ctrl+-" },
      { action: "zoom-reset", label: "Actual Size", acc: "Ctrl+0" },
      "separator",
      { action: "toggle-fullscreen", label: "Toggle Full Screen", acc: "F11" },
    ],
  },
  {
    id: "window",
    label: "Window",
    items: [
      { action: "minimize", label: "Minimize", acc: "Ctrl+M" },
      { action: "close", label: "Close", acc: "Ctrl+W" },
    ],
  },
  {
    id: "help",
    label: "Help",
    items: [
      { action: "about", label: "About correlate-app" },
      "separator",
      { subLabel: "Developers" },
      { action: "toggle-devtools", label: "Toggle Developer Tools", acc: "F12", indent: true },
    ],
  },
];

/** A shortcut as shown: cttc's text, "⌘" and "⇧⌘" on macOS (`app.js:4315-4320`). */
export function accText(acc: string, mac: boolean): string {
  return mac ? acc.replace(/Ctrl\+Shift\+/, "⇧⌘").replace(/Ctrl\+/, "⌘") : acc;
}

/**
 * The shortcuts the window answers itself, cttc's `ACCELERATORS`
 * (`app.js:4563-4575`): those with no default of their own. Edit shortcuts
 * are the field's (and, on macOS, the native Edit menu's).
 */
export const SHORTCUTS: Readonly<Record<string, string>> = {
  "mod+r": "reload",
  f12: "toggle-devtools",
  "mod+=": "zoom-in",
  "mod+-": "zoom-out",
  "mod+0": "zoom-reset",
  f11: "toggle-fullscreen",
  "mod+m": "minimize",
  "mod+w": "close",
  "mod+q": "quit",
};

/** The action a key press asks for, if any: ⌘ is the modifier on macOS, Ctrl elsewhere. */
export function shortcutFor(
  event: { key: string; metaKey: boolean; ctrlKey: boolean },
  mac: boolean,
): string | undefined {
  const key = event.key.toLowerCase();
  if (["control", "meta", "shift", "alt"].includes(key)) return undefined;
  const mod = mac ? event.metaKey : event.ctrlKey;
  return SHORTCUTS[mod ? `mod+${key}` : key];
}
