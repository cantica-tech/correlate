/**
 * The event and artifact both sides of the events' dialogs show
 * (REQ-000046-sJpO9KMY): ours through the page's fake Sump, cttc's in its
 * fixture's markup.
 */

/** A triggered event: cpu > 80 on the "self" stream, a 5-minute snapshot. */
export const EVENT_FIXTURE = {
  id: "evt-1",
  owner: "ann",
  version: 1,
  name: "busy",
  stream: "self",
  containers: [],
  host: false,
  conditions: [{ type: "metric", metric: "cpu", op: ">", threshold: 80 }],
  match: "any",
  action: { kind: "snapshot", minutes: 5, keep_days: 0 },
  enabled: true,
  status: "triggered",
  trigger_count: 1,
  trigger_detail: "web cpu 92.0 > 80",
  triggered_at: 1,
};

/** Its complete snapshot, 1.2 MB. */
export const ARTIFACT_FIXTURE = {
  id: "0123456789abcdef",
  event: "evt-1",
  kind: "snapshot",
  status: "complete",
  from: 0,
  to: 0,
  created_at: Date.UTC(2026, 10, 22, 12, 0, 30),
  expires_at: null,
  safe: false,
  size: 1_200_000,
  reason: null,
};
