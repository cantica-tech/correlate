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

export const MENUS: readonly Menu[] = [
  {
    id: "file",
    label: "File",
    items: [
      {
        action: "open-project",
        label: "Open Project…",
        acc: "Ctrl+O",
        icon: "load-data",
        later: true,
        title: "Open a saved project or an imported recording",
      },
      {
        action: "opened-data",
        label: "Opened Data…",
        icon: "opened-data",
        later: true,
        title: "Switch to one of the open projects",
      },
      {
        action: "export",
        label: "Export…",
        icon: "export",
        later: true,
        title: "Export this project's metrics and logs as text or JSON",
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
