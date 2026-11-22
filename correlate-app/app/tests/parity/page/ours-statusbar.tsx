/**
 * Our side of the status bar parity check (REQ-000022-sJpO9KMY Requirement
 * 5): our StatusBar on a bridge that answers with `statusbar-data.ts`; the
 * test opens the switcher, the menu, Current Status or History by clicking.
 */
import { createRoot } from "react-dom/client";
import "../../../renderer/src/theme/tokens.css";
import "../../../renderer/src/theme/cttc.generated.css";
import type { ShellBridge } from "../../../renderer/src/shell/bridge.js";
import { StatusBar } from "../../../renderer/src/statusbar/StatusBar.js";
import { ARRIVING, HISTORY, SUMPS } from "./statusbar-data.js";

const none = () => () => {};
const bridge = {
  sump: {
    active: async () => ({ id: "local", name: "This machine", kind: "local" }),
    states: async () => SUMPS.map((s) => ({ id: s.id, state: s.state, since: "", reason: "" })),
    onState: none,
    list: async () => SUMPS,
    switchTo: async () => ({ ok: false, step: "check", message: "not here" }),
    // The data streams, for the data-stream pill (REQ-000027-sJpO9KMY).
    request: async ({ path }: { path: string }) =>
      path === "/streams"
        ? {
            ok: true,
            value: {
              streams: [{ id: "self", kind: "self", label: "This Sump's host", following: 2 }],
            },
          }
        : { ok: false, error: { kind: "network", message: "not here" } },
  },
  stream: { active: async () => "self", setActive: async () => ({ ok: true }) },
  status: {
    history: async () => HISTORY,
    add: async () => ({ ok: true }),
    clear: async () => ({ ok: true }),
    visible: async () => true,
    setVisible: async () => ({ ok: true }),
    onNotice: (listener: (e: { type: "entry"; entry: typeof ARRIVING }) => void) => {
      setTimeout(() => listener({ type: "entry", entry: ARRIVING }), 50);
      return () => {};
    },
    onVisibility: none,
  },
} as unknown as ShellBridge;

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <div id="stage">
      <div className="filler" />
      <StatusBar
        bridge={bridge}
        onStreamAction={() => {}}
        mode={location.search.includes("analysis") ? "analysis" : "live"}
        recording={location.search.includes("recording") ? "recording" : "idle"}
      />
    </div>,
  );
}
