/**
 * cttc's side of the picker's parity check (REQ-000025-sJpO9KMY Requirement
 * 5): cttc's `#dlg-set` markup (`index.html:312-375` at d8a444b) as cttc's
 * code leaves it after a fetch (`set-dialog.ts`: the status line, the
 * `#docker-targets` groups with ✔ marks and a gone target), with
 * correlate-app's labels and data: a data stream select where cttc had its
 * connection fields, and no transforms box (correlate-app has none yet).
 */
import { ICONS } from "../../renderer/src/icons/icons.generated.js";
import { STREAMS, TARGETS } from "./page/streams-data.js";

const svg = (name: keyof typeof ICONS, cls: string) =>
  ICONS[name].replace("<svg ", `<svg class="${cls}" `);

/** cttc's dialog for the parity data. */
export function cttcStreamsDialog(): string {
  const followed = new Set(TARGETS.followed.containers);
  const present = new Set(TARGETS.containers.map((c) => c.name));
  const rows = TARGETS.containers
    .map(
      (c) =>
        `<label><input type="checkbox" value="${c.name}" data-type="container"${followed.has(c.name) ? " checked" : ""}><span class="mark">${followed.has(c.name) ? "✔" : ""}</span> ${c.name} <span class="tdoc">${c.image}</span></label>`,
    )
    .join("");
  const gone = TARGETS.followed.containers
    .filter((n) => !present.has(n))
    .map(
      (n) =>
        `<label class="unavailable"><input type="checkbox" value="${n}" data-type="container" checked disabled><span class="mark">🚫</span> ${n} <span class="tdoc">no longer available</span></label>`,
    )
    .join("");
  const options = STREAMS.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
  return `<dialog id="dlg-set">
    <h2 id="dlg-set-title">Edit Data Streams</h2>
    <fieldset class="dlg-section" id="set-source-box">
      <legend>${svg("set-source", "legend-icon")}Set source</legend>
      <label class="ctl block">Data stream <select id="stream-select">${options}<option value="">New, over SSH…</option></select></label>
      <div class="ctl fetch-row">
        <button id="btn-ps-refresh" class="btn-fetch" title="Lists the containers and services running there now">${svg("fetch", "btn-fetch-icon")}<span id="btn-ps-refresh-label">Fetch Sources</span></button>
      </div>
      <div id="docker-status" class="muted">${TARGETS.containers.length} running</div>
      <div id="docker-error" class="error"></div>
    </fieldset>
    <p class="dlg-intro muted">Logs and CPU/MEM/NET telemetry are collected for what you tick, by the Sump, even while this app is closed.</p>
    <fieldset class="dlg-section">
      <legend>${svg("history", "legend-icon")}Logs</legend>
      <p class="dlg-section-help muted">Followed per container — tick the ones you want; what you untick stops.</p>
      <div id="docker-targets"><div class="group" title="Click to select/deselect all of this group">Containers (docker logs)</div>${rows}${gone}</div>
    </fieldset>
    <div class="dlg-actions">
      <button id="dlg-cancel" title="Close without changing what is followed">Cancel</button>
      <button id="dlg-ok" class="primary" title="Follow exactly the ticked containers and services">Follow Selected</button>
    </div>
  </dialog>`;
}
