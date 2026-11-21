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
 * cttc's flat head button (`.btn-flat`, as its Bring Back,
 * `index.html:234`), in the charts' head, labelled "Now" with the track icon:
 * the app's way back to following now (REQ-000030-sJpO9KMY).
 */
export function cttcNowButton(trackSvg: string): string {
  return `<div class="panel-head-right"><button class="btn-flat" title="Follow now again">${trackSvg.replace("<svg ", '<svg class="btn-flat-icon" ')}Now</button></div>`;
}

/** The script that colors the swatches, as cttc's `colorFor` did. */
export function cttcSwatchScript(): string {
  return `document.querySelectorAll("#legend .legend-swatch").forEach((el, i) => { el.style.background = ${JSON.stringify(
    LEGEND.map(([, token]) => `var(${token})`),
  )}[i]; });`;
}
