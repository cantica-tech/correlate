/**
 * The sidebar's parity cases (REQ-000021-sJpO9KMY Requirement 5): the same
 * layouts on cttc's page and ours.
 */
import type { SidebarLayout } from "../../../renderer/src/shell/bridge.js";

const base: SidebarLayout = {
  dock: "left",
  lastDock: "left",
  width: 210,
  collapsed: false,
  expanded: { sump: true, projects: false, events: false },
};

export const SIDEBAR_CASES: Record<string, { layout: SidebarLayout; detached?: boolean }> = {
  open: { layout: base },
  rail: { layout: { ...base, collapsed: true } },
  right: {
    layout: {
      ...base,
      dock: "right",
      lastDock: "right",
      width: 260,
      expanded: { sump: false, projects: true, events: true },
    },
  },
  detached: { layout: { ...base, dock: "detached" }, detached: true },
};
