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
