/**
 * Our side of the picker's parity check (REQ-000025-sJpO9KMY Requirement
 * 5): our StreamsDialog, opened as Edit, on a bridge answering with
 * `streams-data.ts`.
 */
import { createRoot } from "react-dom/client";
import "../../../renderer/src/theme/tokens.css";
import "../../../renderer/src/components/components.css";
import "../../../renderer/src/shell/shell.css";
import type { ShellBridge } from "../../../renderer/src/shell/bridge.js";
import { StreamsDialog } from "../../../renderer/src/streams/StreamsDialog.js";
import { STREAMS, TARGETS } from "./streams-data.js";

const answers: Record<string, unknown> = {
  "/streams": { streams: STREAMS },
  "/plugins/ssh/public-key": { public_key: "ssh-ed25519 AAAA correlate-sump" },
  "/streams/self/targets": TARGETS,
};
const bridge = {
  sump: {
    request: async ({ path }: { path: string }) => ({ ok: true, value: answers[path] }),
  },
  status: { add: async () => ({ ok: true }) },
} as unknown as ShellBridge;

const root = document.getElementById("root");
if (root) createRoot(root).render(<StreamsDialog bridge={bridge} mode="edit" onClose={() => {}} />);
