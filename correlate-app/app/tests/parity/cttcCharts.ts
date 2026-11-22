/**
 * cttc's side of the charts' parity check (REQ-000028-sJpO9KMY Requirement
 * 4): cttc's chart block (`index.html:214-227` at d8a444b, its legend as
 * `legendItem` builds it, `app.js:988-997`), with our containers and no
 * head buttons (correlate-app's come with Items 32 and 33). The swatches'
 * colors are set by script, as cttc's `colorFor` did: the pages' CSP refuses
 * a style attribute written as markup.
 */

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
