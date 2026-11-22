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

/**
 * cttc's Create Event dialog (`index.html:458-499`) as `resetEventForm` opens
 * it, adapted as the app's is (REQ-000046-sJpO9KMY): no "Hosted on"; the
 * systems are a data stream (the charts page's), its containers and its host;
 * "Keep longer" in days.
 */
export function cttcEventFormDialog(): string {
  return `<dialog id="dlg-event-form">
    <h2 id="event-form-title">Create Event</h2>
    <p class="dlg-intro muted">Watch CPU/MEM/NET thresholds or a log regex on chosen systems, and automatically take a snapshot or start a recording when the condition is met. Keeps watching until disabled or deleted (see Edit Events).</p>
    <label class="ctl block">Name <input id="event-name" type="text" placeholder="e.g. high CPU on api" /></label>
    <div class="dlg-section-help muted">Systems monitored</div>
    <div id="event-systems"><label class="ctl block">Data stream <select id="event-stream"><option value="self" selected>This Sump's host</option></select></label><label class="ctl block"><input type="checkbox" data-event-system="1" value="db"> db (container)</label><label class="ctl block"><input type="checkbox" data-event-system="1" value="web"> web (container)</label><label class="ctl block"><input type="checkbox" data-event-system="1" value="__host__"> host (host)</label></div>
    <label class="ctl block">Trigger <select id="event-trigger"><option value="conditions">When conditions are met</option><option value="once">Once, at a time</option><option value="cron">On a schedule (cron)</option></select></label>
    <div class="dlg-section-help muted">Conditions (one or more)</div>
    <div id="event-conditions"><div class="keys-box" data-condition-row="1">
    <label class="ctl">Condition
      <select data-field="type">
        <option value="metric">Metric threshold</option>
        <option value="log">Log regular expression</option>
      </select>
    </label>
    <span data-fields="metric">
      <label class="ctl">Metric
        <select data-field="metric">
          <option value="cpu">CPU %</option>
          <option value="mem">MEM %</option>
          <option value="net">NET B/s</option>
        </select>
      </label>
      <label class="ctl">Op
        <select data-field="op">
          <option value=">">&gt;</option>
          <option value="<">&lt;</option>
          <option value=">=">&gt;=</option>
          <option value="<=">&lt;=</option>
          <option value="=">=</option>
        </select>
      </label>
      <label class="ctl">Threshold <input data-field="threshold" type="number" step="any" value="80" /></label>
    </span>
    <span data-fields="log" hidden>
      <label class="ctl block">Regex <input data-field="pattern" type="text" placeholder="e.g. ERROR|FATAL" /></label>
    </span>
    <button type="button" data-remove-condition>Remove</button>
  </div></div>
    <div class="dlg-actions">
      <button type="button" id="event-add-condition">+ Add condition</button>
    </div>
    <label class="ctl block" id="event-match-row" hidden>Trigger when
      <select id="event-match">
        <option value="any">any condition is met</option>
        <option value="all">all conditions are met</option>
      </select>
    </label>
    <label class="ctl block">Action
      <select id="event-action-kind">
        <option value="snapshot">Take a snapshot</option>
        <option value="recording">Start a recording</option>
      </select>
    </label>
    <label class="ctl" id="event-action-minutes-row">Window (minutes) <input id="event-action-minutes" type="number" min="1" step="1" value="5" /></label>
    <label class="ctl" id="event-action-duration-row" hidden>Duration (minutes) <input id="event-action-duration" type="number" min="1" step="1" value="10" /></label>
    <label class="ctl block">
      <input id="event-safe" type="checkbox" />
      Keep longer than the default retention window
    </label>
    <label class="ctl" id="event-max-keep-row" hidden>Keep (days, at most 30) <input id="event-keep-days" type="number" min="1" max="30" step="1" value="7" /></label>
    <div class="dlg-actions">
      <button id="dlg-event-form-cancel">Cancel</button>
      <button id="dlg-event-create" class="primary">Create event</button>
    </div>
  </dialog>`;
}

/**
 * cttc's Edit Events dialog (`index.html:503-510`) as `renderEventRow` fills
 * it, for `EVENT_FIXTURE`, with the app's artifact rows under it
 * (REQ-000046-sJpO9KMY); `at` is the artifact's time as the app shows it.
 */
export function cttcEventListDialog(at: string): string {
  return `<dialog id="dlg-event-list">
    <h2>Edit Events</h2>
    <p class="dlg-intro muted">This Sump's events -- update, disable/enable, or erase; download what they captured.</p>
    <div id="events-list"><div><div class="ctl block">busy -- cpu &gt; 80 -> snapshot (last 5m) -- triggered (web cpu 92.0 &gt; 80) <button type="button">Update</button><button type="button">Disable</button><button type="button">Reset</button><button type="button">Erase</button></div><div class="ctl block event-artifact">  snapshot · complete · ${at} · 1.2 MB <button type="button" title="Save it into the project">Download…</button><button type="button" title="Keep it 30 days on the Sump">Keep…</button></div></div></div>
    <div class="dlg-actions">
      <button id="dlg-event-list-close">Close</button>
    </div>
  </dialog>`;
}

/**
 * cttc's Preferences dialog (`index.html:518-660`), with the app's words:
 * its own log, its Hard Reset, its Time window help (REQ-000031), the own log
 * on in a folder and the status bar shown (REQ-000050-sJpO9KMY).
 */
export function cttcPreferencesDialog(): string {
  return `  <dialog id="dlg-preferences">
    <div class="mac-settings">
      <nav class="mac-settings-sidebar">
        <span class="mac-settings-sidebar-label"><svg viewBox="-12 0 512 512" fill="currentColor" aria-hidden="true"><path d="m450.144531 279.988281v-47.976562l34.414063-48.15625c4.5625-6.378907 4.972656-14.835938 1.046875-21.628907l-39.519531-68.453124c-3.921876-6.792969-11.449219-10.667969-19.257813-9.90625l-58.910156 5.726562-41.550781-23.988281-24.492188-53.882813c-3.25-7.140625-10.367188-11.722656-18.210938-11.722656h-79.042968c-7.84375 0-14.960938 4.582031-18.207032 11.722656l-24.496093 53.882813-41.550781 23.988281-58.910157-5.726562c-7.800781-.757813-15.332031 3.113281-19.253906 9.90625l-39.523437 68.453124c-3.921876 6.792969-3.511719 15.25 1.050781 21.628907l34.414062 48.15625v47.976562l-34.417969 48.15625c-4.558593 6.378907-4.96875 14.835938-1.046874 21.628907l39.523437 68.453124c3.917969 6.792969 11.453125 10.667969 19.253906 9.90625l58.910157-5.726562 41.550781 23.988281 24.496093 53.882813c3.246094 7.136718 10.363282 11.722656 18.207032 11.722656h79.042968c7.84375 0 14.960938-4.582031 18.207032-11.722656l24.496094-53.882813 41.550781-23.988281 58.910156 5.726562c7.820313.765626 15.335937-3.113281 19.253906-9.90625l39.523438-68.453124c3.921875-6.792969 3.511719-15.25-1.050781-21.628907zm-406.386719 60.9375 17.359376-24.289062 75.007812-43.308594c6.183594-3.566406 9.996094-10.164063 10-17.300781.0625-69.6875 71.054688-117.503906 135.902344-90.414063l-67.550782 39.003907c-9.558593 5.519531-12.84375 17.753906-7.320312 27.320312l39.332031 68.125c5.523438 9.566406 17.753907 12.84375 27.320313 7.320312l67.554687-39c-8.960937 69.679688-85.835937 107.296876-146.25 72.488282-6.1875-3.5625-13.804687-3.558594-19.988281.011718l-75.007812 43.304688-29.710938 2.886719zm370.113282-42.894531 30.65625 42.894531-26.644532 46.148438-52.476562-5.101563c-4.148438-.402344-8.324219.5-11.9375 2.585938l-52.65625 30.402344c-3.609375 2.085937-6.480469 5.246093-8.207031 9.042968l-21.816407 47.996094h-53.292968l-21.816406-47.996094c-1.726563-3.796875-4.597657-6.957031-8.207032-9.042968l-30.328125-17.511719 28.503907-16.457031c102.195312 47.667968 214.574218-40.59375 194.191406-150.222657-2.515625-13.542969-17.703125-20.566406-29.664063-13.664062l-79.046875 45.636719-19.332031-33.484376 79.046875-45.636718c11.929688-6.886719 13.492188-23.546875 2.996094-32.523438-84.78125-72.492187-217.375-19.238281-227.191406 93.066406l-28.503907 16.453126v-35.019532c0-4.167968-1.304687-8.234375-3.730469-11.628906l-30.65625-42.894531 26.648438-46.148438 52.472656 5.101563c4.152344.402344 8.324219-.5 11.933594-2.585938l52.660156-30.402344c3.609375-2.085937 6.480469-5.246093 8.207032-9.042968l21.820312-47.996094h53.289062l21.820313 47.996094c1.726563 3.796875 4.59375 6.957031 8.207031 9.042968l52.65625 30.402344c3.609375 2.082032 7.777344 2.988282 11.933594 2.585938l52.476562-5.101563 26.648438 46.148438-30.65625 42.894531c-2.425781 3.394531-3.730469 7.457031-3.730469 11.628906v60.804688c0 4.167968 1.300781 8.234375 3.726563 11.628906zm0 0"/></svg>Preferences</span>
        
        <button type="button" class="mac-settings-search" title="Search (coming soon)" disabled><svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="m292 80c-77.196 0-140 62.804-140 140s62.804 140 140 140 140-62.804 140-140-62.804-140-140-140zm97.989 120h-38.507c-1.262-24.255-4.859-47.745-10.975-67.42 25.09 13.978 43.576 38.437 49.482 67.42zm-117.414 40h38.849c-2.545 43.399-12.971 69.987-19.425 78.185-6.453-8.198-16.879-34.786-19.424-78.185zm0-40c2.545-43.399 12.971-69.987 19.425-78.185 6.454 8.198 16.88 34.786 19.425 78.185zm-29.082-67.42c-6.116 19.675-9.714 43.165-10.975 67.42h-38.507c5.906-28.983 24.392-53.442 49.482-67.42zm-49.482 107.42h38.507c1.262 24.255 4.859 47.745 10.975 67.42-25.09-13.978-43.576-38.437-49.482-67.42zm146.496 67.42c6.116-19.675 9.714-43.165 10.975-67.42h38.507c-5.906 28.983-24.392 53.442-49.482 67.42z"/><path d="m292 0c-121.588 0-220 98.396-220 220 0 52.045 17.963 101.324 50.935 140.781l-117.077 117.077c-7.811 7.811-7.811 20.474 0 28.284 7.81 7.81 20.473 7.811 28.284 0l117.077-117.077c39.457 32.972 88.736 50.935 140.781 50.935 121.588 0 220-98.396 220-220 0-121.588-98.396-220-220-220zm0 400c-99.252 0-180-80.748-180-180s80.748-180 180-180 180 80.748 180 180-80.748 180-180 180z"/></svg></button>
        <button type="button" class="mac-settings-item" data-pane="pane-settings" data-active="true"><span class="mac-settings-item-icon"><svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="m20 116h136c0 33.084 26.916 60 60 60s60-26.916 60-60h216c11.046 0 20-8.954 20-20s-8.954-20-20-20h-216c0-33.084-26.916-60-60-60s-60 26.916-60 60h-136c-11.046 0-20 8.954-20 20s8.954 20 20 20zm176-40c0-11.028 8.972-20 20-20s20 8.972 20 20v40c0 11.028-8.972 20-20 20s-20-8.972-20-20z"/><path d="m492 236h-56c0-33.084-26.916-60-60-60s-60 26.916-60 60h-296c-11.046 0-20 8.954-20 20s8.954 20 20 20h296c0 33.084 26.916 60 60 60s60-26.916 60-60h56c11.046 0 20-8.954 20-20s-8.954-20-20-20zm-96 40c0 11.028-8.972 20-20 20s-20-8.972-20-20v-40c0-11.028 8.972-20 20-20s20 8.972 20 20z"/><path d="m492 396h-296c0-33.084-26.916-60-60-60s-60 26.916-60 60h-56c-11.046 0-20 8.954-20 20s8.954 20 20 20h56c0 33.084 26.916 60 60 60s60-26.916 60-60h296c11.046 0 20-8.954 20-20s-8.954-20-20-20zm-356 60c-11.028 0-20-8.972-20-20v-40c0-11.028 8.972-20 20-20s20 8.972 20 20v19.99.01s0 .006 0 .01v19.99c0 11.028-8.972 20-20 20z"/></svg></span>Settings</button>
        <button type="button" class="mac-settings-item" data-pane="pane-preferences"><span class="mac-settings-item-icon"><svg viewBox="0 0 512.001 512.001" fill="currentColor" aria-hidden="true"><g><path d="m60 280h-40c-11.046 0-20-8.954-20-20v-240c0-11.045 8.954-20 20-20h240.001c11.046 0 20 8.954 20 20v40c0 11.046-8.954 20-20 20s-20-8.954-20-20v-20h-200.001v200h20c11.046 0 20 8.954 20 20s-8.954 20-20 20z"/><path d="m180 400c-33.084 0-60-26.916-60-60v-160c0-33.084 26.916-60 60-60h160.001c33.084 0 60 26.916 60 60 0 11.046-8.954 20-20 20s-20-8.954-20-20c0-11.028-8.972-20-20-20h-160.001c-11.028 0-20 8.972-20 20v160c0 11.028 8.972 20 20 20 11.046 0 20 8.954 20 20s-8.954 20-20 20z"/><path d="m372.001 512c-77.196 0-140-62.804-140-140s62.804-140 140-140 140 62.804 140 140-62.804 140-140 140zm0-240c-55.141 0-100 44.86-100 100s44.859 100 100 100 100-44.86 100-100-44.859-100-100-100z"/></g></svg></span>Appearance</button>
      </nav>
      <div class="mac-settings-content">
        <div id="pane-settings" class="mac-settings-pane">
          <h2 class="mac-settings-pane-title"><svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="m20 116h136c0 33.084 26.916 60 60 60s60-26.916 60-60h216c11.046 0 20-8.954 20-20s-8.954-20-20-20h-216c0-33.084-26.916-60-60-60s-60 26.916-60 60h-136c-11.046 0-20 8.954-20 20s8.954 20 20 20zm176-40c0-11.028 8.972-20 20-20s20 8.972 20 20v40c0 11.028-8.972 20-20 20s-20-8.972-20-20z"/><path d="m492 236h-56c0-33.084-26.916-60-60-60s-60 26.916-60 60h-296c-11.046 0-20 8.954-20 20s8.954 20 20 20h296c0 33.084 26.916 60 60 60s60-26.916 60-60h56c11.046 0 20-8.954 20-20s-8.954-20-20-20zm-96 40c0 11.028-8.972 20-20 20s-20-8.972-20-20v-40c0-11.028 8.972-20 20-20s20 8.972 20 20z"/><path d="m492 396h-296c0-33.084-26.916-60-60-60s-60 26.916-60 60h-56c-11.046 0-20 8.954-20 20s8.954 20 20 20h56c0 33.084 26.916 60 60 60s60-26.916 60-60h296c11.046 0 20-8.954 20-20s-8.954-20-20-20zm-356 60c-11.028 0-20-8.972-20-20v-40c0-11.028 8.972-20 20-20s20 8.972 20 20v19.99.01s0 .006 0 .01v19.99c0 11.028-8.972 20-20 20z"/></svg>Settings</h2>
          <fieldset class="keys-box">
            <legend>Time window</legend>
            <p class="dlg-section-help muted">Size of the ± highlight window around the selected time -- not a data-polling rate (the charts are read every 5 s on their own).</p>
            <label class="ctl">
              <input id="win-secs-sidebar" type="number" min="1" step="1" value="5" /> s
            </label>
          </fieldset>
          <fieldset class="keys-box">
            <legend>Live tracking</legend>
            <p class="dlg-section-help muted">While following live, automatically moves the cursor to now + this many seconds on every refresh -- 0 tracks exactly now, negative looks slightly into the past (never positive: the future has no data to show yet).</p>
            <div class="ctl block live-track-enable-row">
              <label class="switch-row">
                <span class="switch">
                  <input id="live-track-toggle-sidebar" type="checkbox" checked />
                  <span class="switch-track"><span class="switch-thumb"></span></span>
                </span>
                <span>Enable Live tracking</span>
              </label>
              <label class="ctl">
                <input id="live-track-secs-sidebar" type="number" max="0" step="1" value="0" /> s
              </label>
            </div>
            <p class="dlg-section-help muted">Double-clicking the chart recenters it on that point in time, which pauses live tracking (like any other pan/zoom). This many seconds later, live tracking resumes on its own. Set to 0 to stay paused until you click "now" yourself.</p>
            <label class="ctl">
              <input id="dblclick-resume-secs-sidebar" type="number" min="0" step="1" value="10" /> s
            </label>
          </fieldset>
          <fieldset class="keys-box" id="fieldset-log-collector">
            <legend>Collect correlate-app's Own Logs</legend>
            <p class="dlg-section-help muted">Write correlate-app's own diagnostic log messages to timestamped .log files in a folder you choose.</p>
            <div class="ctl log-collect-row">
              <label class="ctl switch-row">
                <span class="switch">
                  <input id="log-collect-toggle" type="checkbox" checked />
                  <span class="switch-track"><span class="switch-thumb"></span></span>
                </span>
                <span id="log-collect-status" class="muted">Folder: /Users/me/logs</span>
              </label>
              <button id="btn-ship-logs" class="icon-btn" type="button" title="Ship logs"><svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="m473.889 283.056-40-80c-3.388-6.776-10.314-11.056-17.889-11.056-17.756 0-302.244 0-320 0-7.576 0-14.5 4.28-17.889 11.056l-40 80c-3.1 6.2-2.769 13.562.875 19.459 3.645 5.896 10.082 9.485 17.014 9.485h20v180c0 11.046 8.954 20 20 20h320c11.046 0 20-8.954 20-20v-180h20c6.932 0 13.369-3.589 17.013-9.485 3.644-5.897 3.975-13.26.876-19.459zm-70.249-51.056 20 40h-115.28l-20-40zm-295.279 0h115.278l-20 40h-115.278zm287.639 240h-280v-160h100c7.576 0 14.5-4.28 17.889-11.056l22.111-44.222 22.111 44.223c3.388 6.775 10.314 11.055 17.889 11.055h100z"/><path d="m276 412c0 11.046 8.954 20 20 20h40c11.046 0 20-8.954 20-20s-8.954-20-20-20h-40c-11.046 0-20 8.954-20 20z"/><path d="m241.855 154.14c7.87 7.868 20.557 7.731 28.289 0l39.998-39.998c7.811-7.811 7.811-20.474 0-28.284s-20.475-7.811-28.285 0l-5.857 5.857v-71.715c0-11.046-8.954-20-20-20s-20 8.954-20 20v71.716l-5.858-5.858c-7.811-7.811-20.474-7.811-28.284 0s-7.811 20.474 0 28.284z"/></svg></button>
            </div>
          </fieldset>
          <fieldset class="keys-box">
            <legend>Status Bar</legend>
            <p class="dlg-section-help muted">Non-persistent status bar messages (event notifications, action confirmations) clear automatically after this many seconds. Ongoing/ticking statuses (e.g. a live-tracking countdown) are unaffected.</p>
            <label class="ctl">
              <input id="status-bar-clear-secs-sidebar" type="number" min="1" step="1" value="5" /> s
            </label>
          </fieldset>
          <fieldset class="keys-box danger-zone">
            <legend>Danger</legend>
            <p class="dlg-section-help muted">Remove all saved preferences and reset the application (this cannot be undone!)</p>
            <button id="btn-hard-reset" type="button" class="btn-danger">Hard Reset</button>
          </fieldset>
          <div class="dlg-actions">
            <button id="dlg-settings-close" class="primary" title="Close">Close</button>
          </div>
        </div>
        <div id="pane-preferences" class="mac-settings-pane" hidden>
          <h2 class="mac-settings-pane-title"><svg viewBox="0 0 512.001 512.001" fill="currentColor" aria-hidden="true"><g><path d="m60 280h-40c-11.046 0-20-8.954-20-20v-240c0-11.045 8.954-20 20-20h240.001c11.046 0 20 8.954 20 20v40c0 11.046-8.954 20-20 20s-20-8.954-20-20v-20h-200.001v200h20c11.046 0 20 8.954 20 20s-8.954 20-20 20z"/><path d="m180 400c-33.084 0-60-26.916-60-60v-160c0-33.084 26.916-60 60-60h160.001c33.084 0 60 26.916 60 60 0 11.046-8.954 20-20 20s-20-8.954-20-20c0-11.028-8.972-20-20-20h-160.001c-11.028 0-20 8.972-20 20v160c0 11.028 8.972 20 20 20 11.046 0 20 8.954 20 20s-8.954 20-20 20z"/><path d="m372.001 512c-77.196 0-140-62.804-140-140s62.804-140 140-140 140 62.804 140 140-62.804 140-140 140zm0-240c-55.141 0-100 44.86-100 100s44.859 100 100 100 100-44.86 100-100-44.859-100-100-100z"/></g></svg>Appearance</h2>
          <fieldset class="keys-box">
            <legend>Mode</legend>
            <p class="dlg-section-help muted">Light, dark, or match this computer's system setting.</p>
            <span class="btn-group seg-control" id="theme-mode-switch">
              <button type="button" data-mode="light">Light</button>
              <button type="button" data-mode="dark">Dark</button>
              <button type="button" data-mode="system" data-active="true">System</button>
            </span>
          </fieldset>
          <fieldset class="keys-box">
            <legend>Log highlight color</legend>
            <p class="dlg-section-help muted">Color used to highlight log entries within the poll interval window around the selected time.</p>
            <label class="ctl block">
              <input id="theme-hl-color" type="color" value="#eaff00" />
            </label>
          </fieldset>
          <fieldset class="keys-box">
            <legend>"Now" line</legend>
            <p class="dlg-section-help muted">The dotted line marking the actual current time as it progresses across the graphs.</p>
            <label class="ctl block">
              <input id="theme-now-color" type="color" value="#14b8a6" />
            </label>
            <span class="btn-group seg-control" id="theme-now-style-switch">
              <button type="button" data-style="dotted" data-active="true">Dotted</button>
              <button type="button" data-style="dashed">Dashed</button>
              <button type="button" data-style="solid">Solid</button>
            </span>
          </fieldset>
          <fieldset class="keys-box">
            <legend>Live tracking</legend>
            <p class="dlg-section-help muted">The bar marking where Live tracking has moved the cursor to, and the matching highlight on log entries around it.</p>
            <label class="ctl block">
              <input id="theme-live-track-color" type="color" value="#22c55e" />
            </label>
          </fieldset>
          <fieldset class="keys-box">
            <legend>Recording capture</legend>
            <p class="dlg-section-help muted">The band marking time ranges a recording has already captured, on the charts and density lanes.</p>
            <label class="ctl block">
              <input id="theme-recording-color" type="color" value="#fab219" />
            </label>
            <label class="ctl switch-row">
              <span class="switch">
                <input id="theme-recording-sprockets-toggle" type="checkbox" checked />
                <span class="switch-track"><span class="switch-thumb"></span></span>
              </span>
              <span>Sprocket holes</span>
            </label>
          </fieldset>
          <fieldset class="keys-box">
            <legend>Status bar</legend>
            <p class="dlg-section-help muted">A slim bar at the bottom of the window reporting when an event is created or fires.</p>
            <label class="ctl switch-row">
              <span class="switch">
                <input id="theme-status-bar-toggle" type="checkbox" checked />
                <span class="switch-track"><span class="switch-thumb"></span></span>
              </span>
              <span>Show status bar</span>
            </label>
          </fieldset>
          <div class="dlg-actions">
            <button id="dlg-theme-reset" title="Reset to the default colors">Reset</button>
            <button id="dlg-theme-close" title="Close without saving changes">Cancel</button>
            <button id="dlg-theme-save" class="primary" title="Save these colors">Save</button>
          </div>
        </div>
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
