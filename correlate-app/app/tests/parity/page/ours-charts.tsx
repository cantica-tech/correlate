/**
 * Our side of the charts' parity check (REQ-000028-sJpO9KMY Requirement 4):
 * our ChartBlock on a bridge answering with two followed containers and
 * fixed buckets. The head and the legend are compared; the strips' drawing
 * is the ported `drawChartStrip`, tested on its own.
 */
import { createRoot } from "react-dom/client";
import "../../../renderer/src/theme/tokens.css";
import "../../../renderer/src/theme/cttc.generated.css";
import { ChartBlock } from "../../../renderer/src/charts/ChartBlock.js";
import type { ShellBridge } from "../../../renderer/src/shell/bridge.js";

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

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <div id="stage">
      <ChartBlock bridge={bridge} />
    </div>,
  );
