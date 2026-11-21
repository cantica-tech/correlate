/**
 * cttc's side of the sidebar's parity check (REQ-000021-sJpO9KMY
 * Requirement 5): cttc's sidebar markup (`index.html:75-149`, and
 * `action-bar.html` for the detached window, at d8a444b), written out as
 * cttc's own code would leave it for a given layout (`data-expanded`,
 * `data-current`, the rail arrow), with our sections,
 * labels and icons in it. Drawn under cttc's own `style.css`, it is what our
 * React sidebar must look like.
 */
import { ICONS } from "../../renderer/src/icons/icons.generated.js";
import type { SidebarLayout } from "../../renderer/src/shell/bridge.js";
import { railArrow } from "../../renderer/src/shell/rail.js";
import { AVAILABLE, NOT_YET, SECTIONS, SEPARATOR } from "../../renderer/src/shell/sections.js";

const svg = (name: keyof typeof ICONS, cls?: string) =>
  cls ? ICONS[name].replace("<svg ", `<svg class="${cls}" `) : ICONS[name];

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** cttc's markup for this layout; `detached` is the detached window's. */
export function cttcSidebar(layout: SidebarLayout, detached = false): string {
  const dockControls = detached
    ? `<button type="button" id="ab-redock" class="btn-flat" title="Bring back into the main window">${svg("bring-back", "btn-flat-icon")}Bring Back</button>`
    : `<button type="button" id="ab-collapse-toggle" class="ab-dock-btn" title="${layout.collapsed ? "Show sidebar" : "Hide sidebar"}">${railArrow(layout)}</button>` +
      `<button type="button" class="ab-dock-btn" data-dock-to="left" data-current="${layout.dock === "left"}" title="Dock left">◧</button>` +
      `<button type="button" class="ab-dock-btn" data-dock-to="right" data-current="${layout.dock === "right"}" title="Dock right">◨</button>` +
      `<button type="button" class="ab-dock-btn ab-dock-popout" data-dock-to="detached" data-current="${layout.dock === "detached"}" title="Detach into its own window">⧉</button>`;
  const groups = SECTIONS.map((section) => {
    const open = layout.expanded[section.id];
    const entries = section.entries
      .map((e) =>
        e === SEPARATOR
          ? '<div class="ab-sep"></div>'
          : `<button data-action="${e.action}"${AVAILABLE.has(e.action) ? "" : " disabled"} title="${attr(`${e.title} (${NOT_YET})`)}"><span class="ab-icon">${svg(e.icon)}</span>${e.label}</button>`,
      )
      .join("");
    return (
      `<div class="ab-group" data-section="${section.id}" data-expanded="${open}">` +
      `<button type="button" class="ab-group-header"><span class="ab-group-icon">${svg(section.icon)}</span>` +
      `<span class="ab-group-title">${section.title}</span><span class="ab-chevron">▾</span></button>` +
      `<div class="ab-group-body"${open ? "" : " hidden"}>${entries}</div></div>`
    );
  }).join("");
  const flat =
    `<div class="ab-group ab-group-flat"><button data-action="preferences"><span class="ab-icon">${svg("preferences-window")}</span><span class="ab-group-title">Preferences</span></button></div>` +
    '<div class="ab-group ab-group-flat ab-group-bottom"><button data-action="about"><span class="ab-icon">ⓘ</span>About correlate-app</button></div>' +
    '<div class="ab-group ab-group-flat"><button data-action="quit"><span class="ab-icon">⏻</span>Quit</button></div>';
  const aside = detached
    ? `<aside id="action-bar" class="detached">`
    : `<aside id="action-bar" data-collapsed="${layout.collapsed}">`;
  return `${aside}<div class="ab-dock-controls">${dockControls}</div>${groups}${flat}</aside>`;
}

/**
 * The script that sets the sidebar's width as cttc's `applyActionBarSize`
 * does (`app.js:4502-4511`), through the element's style: the pages' CSP
 * refuses a `style` attribute written as markup, as it would in cttc.
 */
export function cttcWidthScript(layout: SidebarLayout, detached = false): string {
  if (detached || layout.collapsed) return "";
  return `document.getElementById("action-bar").style.width = "${layout.width}px";`;
}
