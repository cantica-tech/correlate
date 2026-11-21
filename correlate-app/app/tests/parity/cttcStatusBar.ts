/**
 * cttc's side of the status bar parity check (REQ-000022-sJpO9KMY
 * Requirement 5): cttc's status bar markup (`index.html:268-306` at
 * d8a444b, less the recording and mode parts and the Docker host pill,
 * which come later), as cttc's code leaves it with something open
 * (`modules/gateway/pill.ts`, `shared/ctx-menu`, `modules/status-bar/`),
 * with our data. Drawn under cttc's own `style.css`.
 */
import { ICONS } from "../../renderer/src/icons/icons.generated.js";
import { statusRows, whereIs } from "../../renderer/src/statusbar/pill.js";
import { ARRIVING, HISTORY, type StatusBarCase, SUMPS } from "./page/statusbar-data.js";

const svg = (name: keyof typeof ICONS, cls?: string) =>
  cls ? ICONS[name].replace("<svg ", `<svg class="${cls}" `) : ICONS[name];

const text = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** cttc's markup for one case; `times` are the notices' times as the page writes them. */
export function cttcStatusBar(open: StatusBarCase, times: Record<string, string>): string {
  const switcher =
    open === "switcher"
      ? `<div id="gateway-dropdown" class="gateway-dropdown" role="menu">${SUMPS.map(
          (s, i) =>
            `${i > 0 ? '<div class="gateway-item-sep"></div>' : ""}<button type="button" class="gateway-item" data-active="${s.current}" data-reachable="${s.state === "active"}"><span class="gateway-item-label">${text(s.name)}</span><span class="gateway-item-loc">${text(whereIs(s))}</span></button>`,
        ).join("")}</div>`
      : "";
  const current = SUMPS.find((s) => s.current);
  const status =
    open === "status" && current
      ? `<div id="connection-info-popup" class="connection-info-popup" role="tooltip">${statusRows(
          current,
        )
          .map((row) =>
            row === null
              ? '<div class="cip-sep"></div>'
              : `<div class="cip-row"><span class="cip-label">${row[0]}</span><span class="cip-val">${text(row[1])}</span></div>`,
          )
          .join("")}</div>`
      : "";
  const feed = [...HISTORY, ARRIVING];
  const history =
    open === "history"
      ? `<div id="status-bar-history-popup" class="status-bar-history-popup"><div class="status-bar-history-head"><span>History</span><button type="button" id="status-bar-history-clear" class="linklike">Clear</button></div><div id="status-bar-history-list" class="activity-log status-bar-history-list">${[
          ...feed,
        ]
          .reverse()
          .map(
            (n) =>
              `<div class="status-bar-history-row"><span class="sbh-ts">${times[n.at]}</span><span>${text(n.text)}</span></div>`,
          )
          .join("")}</div></div>`
      : "";
  return (
    '<div class="filler"></div>' +
    '<div id="app-status-bar" class="app-status-bar">' +
    `<span id="app-status-bar-text">${text(ARRIVING.text)}</span>` +
    '<span class="status-bar-divider"></span>' +
    `<div id="server-status" class="server-status${open === "switcher" ? " open" : ""}" data-state="up">` +
    `<button id="server-status-btn" type="button" class="server-status-btn"><span class="server-status-dot"></span>${svg("sump", "server-status-icon")}</button>` +
    switcher +
    status +
    "</div>" +
    '<span class="status-bar-divider status-bar-divider-double"></span>' +
    `<button type="button" id="status-bar-history-btn" class="status-bar-history-btn" title="History">${svg("history")}History</button>` +
    history +
    "</div>"
  );
}

/** cttc's context menu for the pill (`modules/gateway/pill.ts`), on its own. */
export function cttcPillMenu(): string {
  const entry = (label: string, icon?: keyof typeof ICONS, disabled = true) =>
    `<button${disabled ? " disabled" : ""}>${icon ? `<span class="ctxmenu-icon">${svg(icon)}</span>` : ""}<span>${label}</span></button>`;
  return (
    '<div id="ctxmenu" data-owner="gateway">' +
    entry("New Sump…", "new") +
    entry("Edit Sump…", "edit") +
    entry("Uninstall Sump…", "remove") +
    '<div class="ctxmenu-sep"></div>' +
    entry("Current Status", "current-status", false) +
    "</div>"
  );
}
