/**
 * cttc's side of the live settings' parity check (REQ-000031-sJpO9KMY
 * Requirement 5): the Time window and Live tracking fieldsets of cttc's
 * Settings pane, verbatim (`index.html:531-556`, d8a444b).
 */

/** cttc's two fieldsets. */
export function cttcLivePrefs(): string {
  return '<fieldset class="keys-box">\n  <legend>Time window</legend>\n  <p class="dlg-section-help muted">Size of the \u00b1 highlight window around the selected time -- not a data-polling rate (see the toolbar\'s Frequency field for that).</p>\n  <label class="ctl">\n    <input id="win-secs-sidebar" type="number" min="1" step="1" value="5" /> s\n  </label>\n</fieldset>\n<fieldset class="keys-box">\n  <legend>Live tracking</legend>\n  <p class="dlg-section-help muted">While following live, automatically moves the cursor to now + this many seconds on every refresh -- 0 tracks exactly now, negative looks slightly into the past (never positive: the future has no data to show yet).</p>\n  <div class="ctl block live-track-enable-row">\n    <label class="switch-row">\n      <span class="switch">\n        <input id="live-track-toggle-sidebar" type="checkbox" checked />\n        <span class="switch-track"><span class="switch-thumb"></span></span>\n      </span>\n      <span>Enable Live tracking</span>\n    </label>\n    <label class="ctl">\n      <input id="live-track-secs-sidebar" type="number" max="0" step="1" value="0" /> s\n    </label>\n  </div>\n  <p class="dlg-section-help muted">Double-clicking the chart recenters it on that point in time, which pauses live tracking (like any other pan/zoom). This many seconds later, live tracking resumes on its own. Set to 0 to stay paused until you click "now" yourself.</p>\n  <label class="ctl">\n    <input id="dblclick-resume-secs-sidebar" type="number" min="0" step="1" value="10" /> s\n  </label>';
}
