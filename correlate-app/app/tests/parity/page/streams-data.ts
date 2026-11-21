/**
 * The picker's parity data (REQ-000025-sJpO9KMY Requirement 5): the same
 * stream and targets on cttc's page and ours.
 */
import type { Stream, Targets } from "../../../renderer/src/streams/api.js";

export const STREAMS: Stream[] = [{ id: "self", kind: "self", label: "This Sump's host" }];

export const TARGETS: Targets = {
  containers: [
    { id: "1", name: "web", image: "nginx:alpine" },
    { id: "2", name: "db", image: "postgres:17" },
  ],
  services: null,
  followed: { containers: ["web", "ticker"], services: [] },
};

/** The streams the Remove dialog is given ("self" is not offered). */
export const REMOVE_STREAMS: Stream[] = [
  { id: "self", kind: "self", label: "This Sump's host" },
  { id: "ssh:ops@lab:22", kind: "ssh", label: "ops@lab" },
];
