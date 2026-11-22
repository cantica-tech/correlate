/**
 * cttc's side of the status bar parity check (REQ-000022-sJpO9KMY
 * Requirement 5): cttc's status bar markup (`index.html:268-306` at
 * d8a444b, less the recording parts, which come later; its mode icons since
 * REQ-000033-sJpO9KMY), as cttc's code leaves it with something open
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
    // cttc's mode icons (index.html:286-288): live, or analysis.
    `<span id="status-bar-mode-live" class="toolbar-mode-icon"${open === "analysis" ? " hidden" : ""} title="Live tracking">${svg("track")}</span>` +
    `<span id="status-bar-mode-record" class="toolbar-mode-icon"${open === "analysis" ? "" : " hidden"} title="Analysis mode">${svg("analysis-mode-status-bar")}</span>` +
    '<span class="toolbar-mode-divider"></span>' +
    // cttc's recording indicator (index.html:289-291), idle: hidden (REQ-000037-sJpO9KMY).
    (open === "recording"
      ? '<span id="status-bar-recording-dot" class="recording-dot" data-state="recording" title="Recording"></span>'
      : '<span id="status-bar-recording-dot" class="recording-dot" hidden title="Recording"></span>') +
    '<span id="status-bar-recording-glyph" hidden title="Recording paused">⏸</span>' +
    (open === "recording"
      ? '<span id="status-bar-recording-text">recording</span>'
      : '<span id="status-bar-recording-text" hidden></span>') +
    `<span id="app-status-bar-text">${text(ARRIVING.text)}</span>` +
    '<span class="status-bar-divider"></span>' +
    `<div id="server-status" class="server-status${open === "switcher" ? " open" : ""}" data-state="up">` +
    `<button id="server-status-btn" type="button" class="server-status-btn"><span class="server-status-dot"></span>${svg("sump", "server-status-icon")}</button>` +
    switcher +
    status +
    "</div>" +
    // The data-stream pill, cttc's Docker host pill (REQ-000027-sJpO9KMY).
    '<div id="docker-host-status" class="server-status" data-state="up">' +
    `<button id="docker-host-status-btn" type="button" class="server-status-btn"><span class="server-status-dot"></span>${svg("data-stream", "server-status-icon")}</button>` +
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
