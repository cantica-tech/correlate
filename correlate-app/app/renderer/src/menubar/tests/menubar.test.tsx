/**
 * The menu bar (REQ-000023-sJpO9KMY Requirements 1 and 3): its menus, the
 * shortcut text on each system, the shortcuts the window answers, its
 * markup, and `menubar.css` held to cttc's rules.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MENU_ACTIONS } from "../../../../main/src/menu.js";
import { bare, cssBlocks, cttcRules } from "../../testing/cttcCss.js";
import { MenuBar } from "../MenuBar.js";
import {
  accText,
  MENUS,
  type MenuItem,
  PROJECT_ACTIONS,
  SHORTCUTS,
  shortcutFor,
} from "../menus.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const items = MENUS.flatMap((m) =>
  m.items.filter((i): i is MenuItem => typeof i === "object" && "action" in i),
);

describe("REQ-000023-sJpO9KMY: the menus", () => {
  it("are cttc's five, with correlate-app's File entries", () => {
    expect(MENUS.map((m) => m.label)).toEqual(["File", "Edit", "View", "Window", "Help"]);
    expect(items.map((i) => i.label)).toEqual([
      "New Project",
      "Open Project…",
      "Save Project",
      "Save Project As…",
      "Add Files…",
      "Start or Resume Recording",
      "Pause Recording",
      "Stop Recording…",
      "Export…",
      "Restart",
      "Quit",
      "Undo",
      "Redo",
      "Cut",
      "Copy",
      "Paste",
      "Select All",
      "Reload",
      "Zoom In",
      "Zoom Out",
      "Actual Size",
      "Toggle Full Screen",
      "Minimize",
      "Close",
      "About correlate-app",
      "Toggle Developer Tools",
    ]);
  });

  it("ask the main process only for actions it knows; the others are not built yet", () => {
    for (const item of items) {
      // The project's run in the window (REQ-000035-sJpO9KMY).
      if (item.later || PROJECT_ACTIONS.includes(item.action))
        expect(MENU_ACTIONS).not.toContain(item.action);
      else expect(MENU_ACTIONS).toContain(item.action);
    }
    for (const action of Object.values(SHORTCUTS)) expect(MENU_ACTIONS).toContain(action);
  });
});

describe("REQ-000023-sJpO9KMY: shortcuts", () => {
  it.each([
    ["Ctrl+Z", "Ctrl+Z", "⌘Z"],
    ["Ctrl+Shift+Z", "Ctrl+Shift+Z", "⇧⌘Z"],
    ["F11", "F11", "F11"],
  ])("show %s as %s elsewhere and %s on macOS", (acc, other, mac) => {
    expect(accText(acc, false)).toBe(other);
    expect(accText(acc, true)).toBe(mac);
  });

  const press = (key: string, mods: { meta?: boolean; ctrl?: boolean } = {}) => ({
    key,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
  });

  it("answer ⌘ on macOS and Ctrl elsewhere", () => {
    expect(shortcutFor(press("r", { meta: true }), true)).toBe("reload");
    expect(shortcutFor(press("r", { ctrl: true }), true)).toBeUndefined();
    expect(shortcutFor(press("R", { ctrl: true }), false)).toBe("reload");
    expect(shortcutFor(press("=", { ctrl: true }), false)).toBe("zoom-in");
    expect(shortcutFor(press("F12"), false)).toBe("toggle-devtools");
    expect(shortcutFor(press("F11"), true)).toBe("toggle-fullscreen");
  });

  it("leave the edit shortcuts and plain keys to the field", () => {
    for (const key of ["c", "v", "x", "a", "z"]) {
      expect(shortcutFor(press(key, { ctrl: true }), false)).toBeUndefined();
      expect(shortcutFor(press(key, { meta: true }), true)).toBeUndefined();
    }
    expect(shortcutFor(press("r"), false)).toBeUndefined();
    expect(shortcutFor(press("Meta", { meta: true }), true)).toBeUndefined();
  });
});

describe("REQ-000023-sJpO9KMY: the bar's markup", () => {
  const out = renderToStaticMarkup(<MenuBar onAction={() => {}} mac={false} />);

  it("is cttc's: menus with labels and lists", () => {
    expect(out).toMatch(
      /^<nav id="menubar" aria-label="Application menu"><div class="menu" data-menu="file"><button class="menu-label" type="button" aria-haspopup="menu" aria-expanded="false">File<\/button><div class="menu-list" role="menu" aria-label="File">/,
    );
  });

  it("has entries with their shortcut, separators, sub-labels and indented entries", () => {
    expect(out).toContain(
      '<button type="button" role="menuitem" data-action="undo">Undo<span class="acc">Ctrl+Z</span></button>',
    );
    expect(out).toContain('<div class="menu-sep"></div>');
    expect(out).toContain('<div class="menu-sub-label">Developers</div>');
    expect(out).toContain('class="menu-indent">Toggle Developer Tools<span class="acc">F12</span>');
  });

  it("shows File's project entries with their icon, working (REQ-000035-sJpO9KMY)", () => {
    expect(out).toContain(
      'data-action="open-project" title="Open a saved project"><span class="menu-item-label"><span class="icon ctxmenu-icon" aria-hidden="true">',
    );
  });

  it("shows ⌘ on macOS", () => {
    expect(renderToStaticMarkup(<MenuBar onAction={() => {}} mac />)).toContain(
      'data-action="redo">Redo<span class="acc">⇧⌘Z</span>',
    );
  });
});

describe("br-STYLE-000001-sJpO9KMY: menubar.css is cttc's", () => {
  const ours = readFileSync(path.join(here, "../menubar.css"), "utf8");
  const blocks = cssBlocks(ours);

  it("is one cttc block, rule for rule", () => {
    expect(blocks).toHaveLength(1);
    expect(bare(ours.slice(ours.indexOf("*/") + 2))).toBe(bare(blocks[0]?.body ?? ""));
    expect(bare(blocks[0]?.body ?? "")).toBe(cttcRules(93, 177));
  });
});
