/**
 * cttc's side of the menu bar parity check (REQ-000023-sJpO9KMY Requirement
 * 5): cttc's `#menubar` markup (`index.html:15-73` at d8a444b) as cttc's
 * code leaves it (`.acc` text turned to ⌘ on macOS, the File entries' icons
 * cloned in a `.ctxmenu-icon`, the open menu `.open`), with correlate-app's
 * entries. Drawn under cttc's own `style.css`.
 */
import { ICONS } from "../../renderer/src/icons/icons.generated.js";
import { accText, MENUS } from "../../renderer/src/menubar/menus.js";
import { NOT_YET } from "../../renderer/src/shell/sections.js";

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** cttc's menu bar with `open` open (or none), shortcuts as on macOS or not. */
export function cttcMenuBar(open: string | null, mac: boolean): string {
  const menus = MENUS.map((menu) => {
    const lines = menu.items
      .map((line) => {
        if (line === "separator") return '<div class="menu-sep"></div>';
        if ("subLabel" in line) return `<div class="menu-sub-label">${line.subLabel}</div>`;
        const label = line.icon
          ? `<span class="menu-item-label"><span class="ctxmenu-icon">${ICONS[line.icon]}</span>${line.label}</span>`
          : `${line.label} `;
        const acc = line.acc ? `<span class="acc">${accText(line.acc, mac)}</span>` : "";
        const cls = line.indent ? ' class="menu-indent"' : "";
        const off = line.later ? ` disabled title="${attr(`${line.title} (${NOT_YET})`)}"` : "";
        return `<button${cls} data-action="${line.action}"${off}>${label}${acc}</button>`;
      })
      .join("");
    return `<div class="menu${open === menu.id ? " open" : ""}" data-menu="${menu.id}"><button class="menu-label" type="button">${menu.label}</button><div class="menu-list" role="menu">${lines}</div></div>`;
  }).join("");
  return `<nav id="menubar">${menus}</nav>`;
}
