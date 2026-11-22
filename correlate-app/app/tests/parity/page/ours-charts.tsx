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
import { SnapshotDialog } from "../../../renderer/src/exports/SnapshotDialog.js";
import { AbandonDialog } from "../../../renderer/src/recording/Abandon.js";
import { RecoveryDialog } from "../../../renderer/src/recording/RecoveryDialog.js";
import { Transport } from "../../../renderer/src/recording/Transport.js";
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
    request: async ({ path, query }: { path: string; query?: Record<string, unknown> }) =>
      path === "/streams"
        ? { ok: true, value: { streams: [stream] } }
        : hostLoading && String(query?.source ?? "").endsWith("/__host__")
          ? { ok: true, value: { values: [null, null, null, null, null] } }
          : { ok: true, value: { values: [1, 2, 3, null, 5] } },
  },
  stream: { active: async () => "self", setActive: async () => ({ ok: true }) },
} as unknown as ShellBridge;

/** Recentres the view once on 55 min back (an hour back to 50 min back, a sixth of the navigator to now), as a double-click does. */
function RecentreOnce({ shown }: { shown: ChartsShown }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on the first answer.
  useEffect(() => shown.recenterAt(Date.now() - 55 * 60_000), []);
  return null;
}

const paused = location.search.includes("paused");
// `?rec=<status>`: the recording transport in that state (REQ-000037-sJpO9KMY).
const rec = new URLSearchParams(location.search).get("rec") as
  | "idle"
  | "recording"
  | "paused"
  | null;
// `?file`: the analysis view's head, with "Back to live tracking" (REQ-000033-sJpO9KMY).
const file = location.search.includes("file");
// `?host-loading`: the host has no figures yet; `?host-folded`: its block folded (REQ-000032-sJpO9KMY).
const hostLoading = location.search.includes("host-loading");
const hostFolded = location.search.includes("host-folded");
// A paused view's thumb depends on now: the page's clock is frozen so both
// sides draw it at the same place, a sixth of the track.
if (paused) {
  const frozen = Date.now();
  Date.now = () => frozen;
}
const prefs = location.search.includes("prefs");
// `?recovery`: the "Recording interrupted" dialog alone (REQ-000038-sJpO9KMY).
const recovery = location.search.includes("recovery");
// `?abandon`: the "Abandon the recording?" dialog alone (REQ-000039-sJpO9KMY).
const abandon = location.search.includes("abandon");
// `?snapshot`: the snapshot dialog alone, cttcSnapshotDialog's values (REQ-000041-sJpO9KMY).
const snapshot = location.search.includes("snapshot");
const SNAPSHOT_T = Date.UTC(2026, 10, 22, 12, 0, 30);
const SNAPSHOT = {
  t: SNAPSHOT_T,
  panoramaOn: false,
  panoramaUnit: "entries" as const,
  panoramaValue: 0,
  generated_at: new Date(SNAPSHOT_T).toISOString(),
  slices: [
    {
      label: "at",
      t: SNAPSHOT_T,
      services: [
        { name: "localhost", host: true, cpu: 80, mem: null, net: null, ts: null },
        { name: "web", host: false, cpu: 12.34, mem: 50, net: 2500, ts: null },
      ],
      logs: [],
    },
  ],
};
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    snapshot ? (
      <SnapshotDialog
        at={SNAPSHOT_T}
        take={async () => SNAPSHOT}
        save={() => {}}
        onClose={() => {}}
      />
    ) : abandon ? (
      <AbandonDialog
        asking={{ action: "Switching to Sump lab", status: "recording" }}
        onCancel={() => {}}
        onAbandon={() => {}}
      />
    ) : recovery ? (
      <RecoveryDialog
        open
        sumpGone={false}
        onInterruption={() => {}}
        onNow={() => {}}
        onLater={() => {}}
      />
    ) : prefs ? (
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
          hostOpen={!hostFolded}
          transport={
            rec
              ? () => (
                  <Transport status={rec} onStart={() => {}} onPause={() => {}} onStop={() => {}} />
                )
              : undefined
          }
          analysis={
            file ? { from: Date.UTC(2026, 7, 6, 12, 0), to: Date.UTC(2026, 7, 6, 12, 4) } : null
          }
        />
      </div>
    ),
  );
