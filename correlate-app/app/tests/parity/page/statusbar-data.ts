/**
 * The status bar's parity data (REQ-000022-sJpO9KMY Requirement 5): the
 * same Sumps, states and notices on cttc's page and ours.
 */
import type { ListedSump, Notice } from "../../../renderer/src/shell/bridge.js";

export const SUMPS: ListedSump[] = [
  {
    id: "local",
    name: "This machine",
    kind: "local",
    sumpPort: 8765,
    state: "active",
    current: true,
  },
  {
    id: "r1",
    name: "lab",
    kind: "remote",
    sshTarget: "ops@lab.example",
    sshPort: 2222,
    sumpPort: 8765,
    forwardUrl: "http://127.0.0.1:54123",
    state: "unreachable",
    current: false,
  },
];

/** The feed before the page opens, oldest first. */
export const HISTORY: Notice[] = [
  { at: "2026-11-21T09:15:02Z", text: "Sump lab connection lost: no /health: fetch failed" },
  { at: "2026-11-21T09:16:40Z", text: "Switched to Sump This machine" },
];

/** The notice that arrives as the page opens, shown in the bar. */
export const ARRIVING: Notice = {
  at: "2026-11-21T09:17:05Z",
  text: "Sump This machine connection restored",
};

/** The cases, each with what is open. */
export const STATUSBAR_CASES = ["bar", "switcher", "menu", "status", "history"] as const;
export type StatusBarCase = (typeof STATUSBAR_CASES)[number];
