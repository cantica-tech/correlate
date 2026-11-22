/**
 * The Opened Data dialog's parity data (REQ-000034-sJpO9KMY Requirement 4),
 * the same on cttc's page and ours: two files of the same name in different
 * folders (matched by full path), and a third, the active one.
 */
export const OPENED_FILES = {
  files: [
    { path: "/data/monday/recording.cttc-record", label: "recording.cttc-record", from: 0, to: 1 },
    { path: "/data/tuesday/recording.cttc-record", label: "recording.cttc-record", from: 0, to: 1 },
    {
      path: "/data/metrics-2026-08-06.cttc-metric",
      label: "metrics-2026-08-06.cttc-metric",
      from: 0,
      to: 1,
    },
  ],
  active: "/data/tuesday/recording.cttc-record",
};
