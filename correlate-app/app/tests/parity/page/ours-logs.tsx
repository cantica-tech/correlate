/**
 * Our side of the log panels' parity check (REQ-000029-sJpO9KMY Requirement
 * 5): our Panels on a bridge answering the parity rows, the cursor on the
 * error row (REQ-000030-sJpO9KMY), and our lanes' head, folded.
 */
import { createRoot } from "react-dom/client";
import "../../../renderer/src/theme/tokens.css";
import "../../../renderer/src/theme/cttc.generated.css";
import { Lanes } from "../../../renderer/src/logs/Lanes.js";
import { Panels } from "../../../renderer/src/logs/Panels.js";
import type { ShellBridge } from "../../../renderer/src/shell/bridge.js";
import { LOG_CURSOR_INDEX, LOG_CURSOR_T, LOG_NAME, LOG_ROWS } from "../logsData.js";

const request = async ({ path }: { path: string }) => ({
  ok: true as const,
  value:
    path === "/records/logs/at"
      ? { index: LOG_CURSOR_INDEX, total: LOG_ROWS.length }
      : { total: LOG_ROWS.length, offset: 0, rows: LOG_ROWS },
});
const bridge = {
  sump: { request },
  status: { add: async () => ({ ok: true }) },
} as unknown as ShellBridge;
const stream = { id: "self", kind: "self" as const, label: "This Sump's host" };
const view = { t0: Date.UTC(2026, 10, 21, 18, 0), t1: Date.UTC(2026, 10, 21, 18, 10) };
const none = () => {};
const shown = {
  stream,
  containers: [LOG_NAME],
  slots: { [LOG_NAME]: 0 },
  view,
  cursorT: LOG_CURSOR_T,
  setCursor: none,
  recenter: none,
  hide: none,
  reorder: none,
};

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <div id="stage">
      <div id="lanes-stage">
        <Lanes
          request={request as never}
          stream="self"
          containers={[LOG_NAME]}
          slots={shown.slots}
          view={view}
          open={false}
          onToggle={() => {}}
        />
      </div>
      <main id="layout">
        <Panels bridge={bridge} shown={shown} order="newest" onOrder={() => {}} />
      </main>
    </div>,
  );
