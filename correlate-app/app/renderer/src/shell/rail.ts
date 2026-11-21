/**
 * The rail button's arrow (REQ-000021-sJpO9KMY Requirement 2), as cttc's
 * `updateCollapseToggleIcon` draws it (`app.js:4458-4466`): docked left,
 * "▸" while open and "◂" as a rail; docked right, the other way round; a
 * detached sidebar keeps its last dock's.
 */
import type { SidebarLayout } from "./bridge.js";

/** The arrow for this layout. */
export function railArrow(layout: Pick<SidebarLayout, "dock" | "lastDock" | "collapsed">): string {
  const dock = layout.dock === "detached" ? layout.lastDock : layout.dock;
  if (layout.collapsed) return dock === "right" ? "▸" : "◂";
  return dock === "right" ? "◂" : "▸";
}
