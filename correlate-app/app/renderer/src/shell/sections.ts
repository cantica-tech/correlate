/**
 * What the sidebar holds (FEAT-000022-sJpO9KMY decisions): the Sump section
 * with its data streams below a separator, Projects in place of cttc's
 * Analysis, Events; then Preferences, About and Quit. An entry whose screen
 * is not built yet is shown disabled until its item lands.
 */
import type { IconName } from "../icons/icons.generated.js";
import type { Section } from "./bridge.js";

/** One entry of a section. */
export interface Entry {
  action: string;
  label: string;
  icon: IconName;
  /** What it does, as its tooltip once it works. */
  title: string;
}

/** A separator between entries. */
export const SEPARATOR = "separator" as const;

/** One section: a header that opens a body of entries. */
export interface SidebarSection {
  id: Section;
  title: string;
  icon: IconName;
  entries: readonly (Entry | typeof SEPARATOR)[];
}

export const SECTIONS: readonly SidebarSection[] = [
  {
    id: "sump",
    title: "Sump",
    icon: "sump",
    entries: [
      {
        action: "new-sump",
        label: "New Sump…",
        icon: "new",
        title: "Provision a Sump here or on a host over SSH",
      },
      {
        action: "edit-sump",
        label: "Edit Sump…",
        icon: "edit",
        title: "Rename a Sump or replace its SSH key",
      },
      {
        action: "uninstall-sump",
        label: "Uninstall Sump…",
        icon: "remove",
        title: "Stop and remove a Sump and everything it kept",
      },
      SEPARATOR,
      {
        action: "new-data-stream",
        label: "New Data Stream…",
        icon: "connect",
        title: "Follow a new data stream on the active Sump",
      },
      {
        action: "edit-data-streams",
        label: "Edit Data Streams…",
        icon: "set-source",
        title: "Choose which of the active Sump's data streams to follow",
      },
      {
        action: "close-data-streams",
        label: "Close Data Streams",
        icon: "disconnect",
        title: "Stop following every data stream; their settings are kept",
      },
      {
        action: "remove-data-stream",
        label: "Remove Data Stream…",
        icon: "remove",
        title: "Forget a data stream and its settings",
      },
      SEPARATOR,
    ],
  },
  {
    id: "projects",
    title: "Projects",
    icon: "project",
    entries: [
      {
        action: "new-project",
        label: "New Project…",
        icon: "new",
        title: "Start a correlation project",
      },
      {
        action: "open-project",
        label: "Open Project…",
        icon: "load-data",
        title: "Open a saved project or an imported recording",
      },
      {
        action: "opened-data",
        label: "Opened Data…",
        icon: "opened-data",
        title: "Switch to one of the open projects",
      },
      SEPARATOR,
    ],
  },
  {
    id: "events",
    title: "Events",
    icon: "events",
    entries: [
      {
        action: "create-event",
        label: "Create Event…",
        icon: "create-event",
        title: "Watch a Sump's metrics or logs and act when a condition is met",
      },
      {
        action: "edit-events",
        label: "Edit Events…",
        icon: "edit",
        title: "Change, turn off or remove events",
      },
      SEPARATOR,
    ],
  },
];

/** The entries that work so far; every other one is disabled. */
export const AVAILABLE: ReadonlySet<string> = new Set([
  "new-data-stream",
  "edit-data-streams",
  "close-data-streams",
  "remove-data-stream",
  // Opens a cttc file in the analysis view until projects come (REQ-000033-sJpO9KMY).
  "open-project",
  // Switches between and removes the open files (REQ-000034-sJpO9KMY).
  "opened-data",
  "preferences",
  "about",
  "quit",
]);

/** The tooltip of an entry not built yet. */
export const NOT_YET = "Not available yet";
