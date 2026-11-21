/**
 * Our side of the charts' parity check (REQ-000028-sJpO9KMY Requirement 4):
 * our ChartBlock on a bridge answering with two followed containers and
 * fixed buckets. The head and the legend are compared; the strips' drawing
 * is the ported `drawChartStrip`, tested on its own. With `?paused`, the view
 * is recentred once, an hour back, as a double-click does, so the navigator
 * shows a paused view (REQ-000031-sJpO9KMY). With `?prefs`, the live settings'
 * fieldsets alone.
 */
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import "../../../renderer/src/theme/tokens.css";
import "../../../renderer/src/theme/cttc.generated.css";
import { ChartBlock, type ChartsShown } from "../../../renderer/src/charts/ChartBlock.js";
import type { ShellBridge } from "../../../renderer/src/shell/bridge.js";
import { LivePreferences } from "../../../renderer/src/shell/LivePreferences.js";

const stream = {
  id: "self",
  kind: "self",
  label: "This Sump's host",
  following: 2,
  // Sorted, as the Sump keeps every followed set.
  followed: { containers: ["db", "web"], services: [] },
};
const bridge = {
  sump: {
    request: async ({ path }: { path: string }) =>
      path === "/streams"
        ? { ok: true, value: { streams: [stream] } }
        : { ok: true, value: { values: [1, 2, 3, null, 5] } },
  },
  stream: { active: async () => "self", setActive: async () => ({ ok: true }) },
} as unknown as ShellBridge;

/** Recentres the view once, 55 min back (an hour back to 50 min back), as a double-click does. */
function RecentreOnce({ shown }: { shown: ChartsShown }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on the first answer.
  useEffect(() => shown.recenterAt(Date.now() - 55 * 60_000 + 5_000), []);
  return null;
}

const paused = location.search.includes("paused");
// A paused view's thumb depends on now: the page's clock is frozen so both
// sides draw it at the same place, a sixth of the track.
if (paused) {
  const frozen = Date.now();
  Date.now = () => frozen;
}
const prefs = location.search.includes("prefs");
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    prefs ? (
      <div id="stage" className="prefs-stage">
        <LivePreferences
          live={{ windowSecs: 5, liveTrack: true, liveTrackSecs: 0, resumeSecs: 10 }}
          onChange={() => {}}
        />
      </div>
    ) : (
      <div id="stage">
        <ChartBlock
          bridge={bridge}
          panels={paused ? (shown) => <RecentreOnce shown={shown} /> : undefined}
        />
      </div>
    ),
  );
