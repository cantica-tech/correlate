/**
 * cttc's side of the charts' parity check (REQ-000028-sJpO9KMY Requirement
 * 4): cttc's chart block (`index.html:214-227` at d8a444b, its legend as
 * `legendItem` builds it, `app.js:988-997`), with our containers and no
 * head buttons (correlate-app's come with Items 32 and 33). The swatches'
 * colors are set by script, as cttc's `colorFor` did: the pages' CSP refuses
 * a style attribute written as markup.
 */

import { ICONS } from "../../renderer/src/icons/icons.generated.js";

/**
 * The containers of the parity data, in legend order, and their color tokens:
 * cttc gives slots in first-seen order, and the Sump's followed sets are
 * sorted, so the first container takes `--series-1`.
 */
export const LEGEND: [string, string][] = [
  ["db", "--series-1"],
  ["web", "--series-2"],
];

/** cttc's chart block's markup. */
export function cttcChartBlock(): string {
  const items = LEGEND.map(
    ([name]) => `<span class="legend-item"><span class="legend-swatch"></span>${name}</span>`,
  ).join("");
  return `<main id="layout"><section id="chart-block"><div id="svc-graph" class="graph-block">
    <div id="chart-head"><span class="panel-head-title">Telemetry</span></div>
    <div class="panel-head-divider"></div>
    <div id="legend">${items}</div>
    <div id="charts"><canvas class="strip"></canvas><canvas class="strip"></canvas><canvas class="strip"></canvas></div>
  </div></section></main>`;
}

/**
 * cttc's host block (`index.html:252-266`) for the Sump's own host, open or
 * folded, loading or not; its style toggle and pop-out buttons hidden, as
 * the app has neither yet (REQ-000032-sJpO9KMY).
 */
export function cttcHostBlock(open: boolean, loading: boolean): string {
  return `<div id="host-block" class="graph-block">
    <div id="host-head"><span id="host-title" class="panel-head-title">Host telemetry — localhost</span>
      <div class="panel-head-right"><button id="btn-host-toggle" class="icon-btn" title="${open ? "Hide host telemetry" : "Show host telemetry"}">${open ? "\u25be" : "\u25b8"}</button><button id="btn-style-toggle-host" class="icon-btn" hidden></button><button id="btn-popout-host" class="icon-btn" hidden>⧉</button></div></div>
    <div class="panel-head-divider"></div>
    <div id="host-charts"${open && !loading ? "" : " hidden"}><canvas class="strip"></canvas><canvas class="strip"></canvas><canvas class="strip"></canvas></div>
    <div id="host-loading" class="muted"${open && loading ? "" : " hidden"}><span class="hourglass">⏳</span> Loading host telemetry…</div>
    ${cttcNav(true).replace('id="chart-nav"', `id="host-nav"${open && !loading ? "" : " hidden"}`)}
  </div>`;
}

/**
 * cttc's "Back to live tracking" (`index.html:214`, its flat action), placed
 * in the charts' head's right cluster, as the app puts it (REQ-000033-sJpO9KMY).
 */
export function cttcBackToLive(): string {
  return `<div class="panel-head-right"><button id="btn-back-to-live" class="flat-action" title="Currently in analysis mode -- click to show live data again">${ICONS.track.replace("<svg ", '<svg class="flat-action-icon" ')}Back to live tracking</button></div>`;
}

/**
 * cttc's recording transport (`index.html:183-187`) in a state, as
 * `syncRecordingMenu` leaves it (`app.js:3316`), in the charts' head's
 * right cluster, where the app puts it (REQ-000037-sJpO9KMY).
 */
export function cttcTransport(status: "idle" | "recording" | "paused"): string {
  const startTitle =
    status === "recording"
      ? "Recording"
      : status === "paused"
        ? "Resume Recording"
        : "Start Recording";
  const off = (yes: boolean) => (yes ? " disabled" : "");
  return `<div class="panel-head-right"><span class="btn-group" id="recording-transport"><button id="btn-start-recording" data-state="${status}" title="${startTitle}"${off(status === "recording")}><span id="recording-glyph">⏺</span><span id="recording-dot" class="recording-dot"></span></button><button id="btn-pause-recording" data-state="${status}" title="${status === "paused" ? "Recording Paused" : "Pause Recording"}"${off(status !== "recording")}><span id="pause-glyph">⏸</span></button><button id="btn-stop-recording" title="Stop Recording"${off(status === "idle")}>⏹</button></span></div>`;
}

/** cttc's "Recording interrupted" dialog (`index.html:800-810`), verbatim (REQ-000038-sJpO9KMY). */
export function cttcRecoveryDialog(): string {
  return `<dialog id="dlg-recording-resume-choice">
    <h2>Recording interrupted</h2>
    <p class="dlg-intro muted">A previous recording was interrupted before it could be paused or stopped. How would you like to resume it?</p>
    <p class="dlg-intro muted"><strong>Resume from the interruption point</strong> continues the same segment from when it was interrupted — whatever telemetry was actually captured in the meantime will be included once you next Pause or Stop; anything genuinely missing (never collected, or past the retention window) stays a real gap.</p>
    <p class="dlg-intro muted"><strong>Resume from now</strong> starts a fresh segment at the moment this app restarted, leaving the interruption itself as an honest, unhighlighted gap.</p>
    <div class="dlg-actions">
      <button id="dlg-recording-resume-choice-later" title="Leave the recording paused for now — Resume/Stop remain available">Decide later</button>
      <button id="dlg-recording-resume-choice-now" title="Start a fresh segment at the moment the app restarted">Resume from now</button>
      <button id="dlg-recording-resume-choice-interruption" class="primary" title="Continue the interrupted segment, backfilling whatever survived in Redis">Resume from the interruption point</button>
    </div>
  </dialog>`;
}

/**
 * The "Abandon the recording?" question (REQ-000039-sJpO9KMY) in cttc's
 * dialog markup: cttc asked it with the system's `confirm`
 * (`confirmAbandonRecordingIfAny`), so its words in cttc's dialog style.
 */
export function cttcAbandonDialog(): string {
  return `<dialog id="dlg-abandon-recording">
    <h2>Abandon the recording?</h2>
    <p class="dlg-intro">Switching to Sump lab will abandon the recording in progress: it has not been saved and will be discarded. Stop first to keep it.</p>
    <div class="dlg-actions">
      <button id="dlg-abandon-recording-cancel">Cancel</button>
      <button id="dlg-abandon-recording-confirm" class="btn-danger" title="Discard the recording, then go on">Abandon recording</button>
    </div>
  </dialog>`;
}

/**
 * cttc's snapshot dialog (`index.html:731-761`) as `renderSnapshot` fills it
 * (`app.js:1457`) for `SNAPSHOT_FIXTURE`'s values (REQ-000041-sJpO9KMY).
 */
export function cttcSnapshotDialog(): string {
  return `<dialog id="dlg-snapshot">
    <h2>Snapshot</h2>
    <div id="snapshot-meta" class="muted">t = 2026-11-22 12:00:30.000 UTC · 2 series · 0 log entries</div>
    <label class="ctl">
      <input id="snap-logs" type="checkbox" checked />
      Include nearby log entries
    </label>
    <label class="ctl switch-row" title="Enlarge the snapshot around the selected time: widen the log context by N entries, or add extra telemetry/log slices N seconds before and after">
      <span class="switch">
        <input id="snap-panorama-on" type="checkbox" />
        <span class="switch-track"><span class="switch-thumb"></span></span>
      </span>
      panorama
      <input id="snap-panorama-value" type="number" min="0" step="1" value="3" disabled />
      <select id="snap-panorama-unit" disabled>
        <option value="entries" selected>entries</option>
        <option value="seconds">seconds</option>
      </select>
    </label>
    <div class="btn-group" id="snapshot-view-switch">
      <button id="snap-view-raw" class="primary" title="Show a human-readable table">Raw</button>
      <button id="snap-view-json" title="Show the raw JSON payload">JSON</button>
    </div>
    <div id="snapshot-props" class="snapshot-body"><table class="snapshot-table"><tr><th>source</th><th>cpu</th><th>mem</th><th>net</th><th>at</th></tr><tr><td>\u{1F5A5} localhost</td><td>80.0%</td><td>\u2013</td><td>\u2013</td><td>\u2013</td></tr><tr><td>web</td><td>12.3%</td><td>50.0%</td><td>2.5 kB/s</td><td>\u2013</td></tr></table></div>
    <pre id="snapshot-json" class="snapshot-body" hidden></pre>
    <div class="dlg-actions">
      <button id="dlg-snapshot-close" title="Close this snapshot">Close</button>
      <button id="dlg-snapshot-save-txt" title="Save this snapshot as a plain-text file">💾 Save as TXT…</button>
      <button id="dlg-snapshot-save" class="primary" hidden title="Save this snapshot as a JSON file">💾 Save as JSON…</button>
    </div>
  </dialog>`;
}

/**
 * cttc's Export metrics dialog (`index.html:817-852`), verbatim but for its
 * Summary title, which says the summary the rule decided
 * (br-EXPORT-000005-sJpO9KMY; REQ-000042-sJpO9KMY).
 */
export function cttcExportMetricsDialog(): string {
  return `  <dialog id="dlg-export-metrics">
    <h2>Export metrics</h2>
    <div id="export-metrics-step1">
      <p class="dlg-intro muted">Export the active metrics file's data as a plain-text or JSON file, covering its whole time range.</p>
      <label class="ctl block">
        <input id="export-metrics-stats" type="checkbox" checked />
        Stats (CPU/MEM/NET telemetry)
      </label>
      <label class="ctl block">
        <input id="export-metrics-logs" type="checkbox" checked />
        Logs
      </label>
      <div class="dlg-actions">
        <button id="dlg-export-metrics-cancel" title="Close without exporting">Cancel</button>
        <button id="dlg-export-metrics-next" class="primary" title="Choose the export format">Next…</button>
      </div>
    </div>
    <div id="export-metrics-step2" hidden>
      <div class="dlg-section-help muted">Format</div>
      <div class="btn-group" id="export-metrics-format-switch">
        <button id="export-metrics-format-text" type="button" class="primary" title="A human-readable plain-text file">Text</button>
        <button id="export-metrics-format-json" type="button" title="A machine-readable JSON file">JSON</button>
      </div>
      <div id="export-metrics-granularity-row">
        <div class="dlg-section-help muted">Stats detail</div>
        <div class="btn-group" id="export-metrics-granularity-switch">
          <button id="export-metrics-granularity-summary" type="button" class="primary" title="Per container: first/last/min/max/mean CPU/MEM/NET over the whole file">Summary</button>
          <button id="export-metrics-granularity-full" type="button" title="Every recorded sample, per container">Full time series</button>
        </div>
      </div>
      <div class="dlg-actions">
        <button id="dlg-export-metrics-back" title="Back to what to include">Back</button>
        <button id="dlg-export-metrics-export" class="primary" title="Save the export">💾 Export…</button>
      </div>
    </div>
  </dialog>`;
}

/** cttc's navigator (`index.html:240-245`), "now" live or not. */
export function cttcNav(live: boolean): string {
  return `<div id="chart-nav" class="timeline-nav" title="Drag the thumb or click the track to pan · click “now” to jump to the present and resume following it"><div class="tl-track"><div class="tl-thumb"></div><span class="tl-now-label" data-live="${live}">now</span></div></div>`;
}

/**
 * The script that places the thumb as cttc's `updateTimelineNav`: across the
 * whole track while live (the view holds now), a sixth of it from the left
 * when the view is an hour back and 10 min wide.
 */
export function cttcNavScript(live: boolean): string {
  return `(() => { const track = document.querySelector(".tl-track"); const thumb = document.querySelector(".tl-thumb"); thumb.style.left = "0px"; thumb.style.width = (track.clientWidth ${live ? "" : "/ 6"}) + "px"; })();`;
}

/** The script that colors the swatches, as cttc's `colorFor` did. */
export function cttcSwatchScript(): string {
  return `document.querySelectorAll("#legend .legend-swatch").forEach((el, i) => { el.style.background = ${JSON.stringify(
    LEGEND.map(([, token]) => `var(${token})`),
  )}[i]; });`;
}
