/**
 * cttc's side of the log panels' parity check (REQ-000029-sJpO9KMY
 * Requirement 5): a panel as cttc's `Panel` builds it (`app.js:2360-2560`,
 * d8a444b): the head (menu, name, ✕), the hidden search bar, the rows as
 * `render` draws them, with the cursor's row and its highlighted run
 * (REQ-000030-sJpO9KMY); and the lanes' head (`index.html:247-250`). Rows are
 * placed by script, as cttc's were: the pages' CSP refuses style attributes.
 */

import { ICONS } from "../../renderer/src/icons/icons.generated.js";
import { clock } from "../../renderer/src/logs/api.js";
import { LOG_CURSOR_INDEX, LOG_HIGHLIGHTED, LOG_NAME, LOG_ROWS } from "./logsData.js";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** cttc's `#panels` with one panel. */
export function cttcPanels(): string {
  const first = Math.min(...LOG_HIGHLIGHTED);
  const last = Math.max(...LOG_HIGHLIGHTED);
  const rows = LOG_ROWS.map(({ ts, text }, i) => {
    const hl = LOG_HIGHLIGHTED.includes(i)
      ? ` hl${i === first ? " hl-top" : ""}${i === last ? " hl-bottom" : ""}`
      : "";
    const cursor = i === LOG_CURSOR_INDEX ? " cursor-row" : "";
    const lvl = /\b(ERROR|FATAL|CRIT)/i.test(text)
      ? " lvl-error"
      : /\bWARN/i.test(text)
        ? " lvl-warn"
        : "";
    return `<div class="log-row${hl}${cursor}${lvl}"><span class="ts">${clock(Date.parse(ts))}</span>${escapeHtml(text)}</div>`;
  }).join("");
  return `<main id="layout"><section id="panels"><div class="panel">
    <div class="panel-head">
      <div class="panel-head-top">
        <button class="icon-btn panel-menu-btn" title="Menu" aria-label="Menu" aria-haspopup="true" aria-expanded="false">${ICONS.menu}</button>
        <div class="panel-head-center"><span class="name">${LOG_NAME}</span><span class="sample-badge" hidden></span></div>
        <div class="panel-head-right"><button class="icon-btn" hidden>⧉</button><button class="close">✕</button></div>
      </div>
      <div class="panel-head-controls"><span class="muted">${LOG_ROWS.length.toLocaleString()} entries</span></div>
    </div>
    <div class="panel-search" hidden><input type="text" placeholder="search…"><button>▲</button><button>▼</button><span class="muted search-status"></span><button>✕</button></div>
    <div class="panel-body"><div class="panel-spacer"></div><div class="panel-empty-state" hidden></div>${rows}</div>
  </div></section></main>`;
}

/** The script that places the rows and sizes the spacer, as cttc's `render`. */
export function cttcRowsScript(): string {
  return `document.querySelectorAll(".log-row").forEach((el, i) => { el.style.top = (i * 22) + "px"; });
    document.querySelector(".panel-spacer").style.height = "${LOG_ROWS.length * 22}px";`;
}

/** cttc's lanes' head. */
export function cttcLanesHead(): string {
  return `<div id="lanes-head"><span>Log entries</span><button id="btn-lanes-toggle" class="icon-btn" title="Show log entry markers">▸</button></div><div id="lanes" hidden></div>`;
}
