/**
 * Our side of the Remove dialog's parity check (REQ-000027-sJpO9KMY
 * Requirement 5): our RemoveDialog, open, on a bridge answering with two
 * streams ("self" is not offered).
 */
import { createRoot } from "react-dom/client";
import "../../../renderer/src/theme/tokens.css";
import "../../../renderer/src/theme/cttc.generated.css";
import type { ShellBridge } from "../../../renderer/src/shell/bridge.js";
import { RemoveDialog } from "../../../renderer/src/streams/RemoveDialog.js";
import { REMOVE_STREAMS } from "./streams-data.js";

const bridge = {
  sump: { request: async () => ({ ok: true, value: { streams: REMOVE_STREAMS } }) },
  status: { add: async () => ({ ok: true }) },
} as unknown as ShellBridge;

const root = document.getElementById("root");
if (root) createRoot(root).render(<RemoveDialog bridge={bridge} open onClose={() => {}} />);
