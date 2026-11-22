/**
 * A Sump's log lines, classified (br-DIAG-000003-sJpO9KMY, cttc's
 * `lib/server-log-level.js`; REQ-000048-sJpO9KMY Requirement 2): DEBUG and
 * INFO are routine; WARNING and above, and any line in no known format (a
 * traceback, a stray print), are errors, never silently downgraded.
 *
 * The Sump's container mixes four formats: Python's default logging
 * (`INFO:correlate_sump.app:…`), uvicorn's (`INFO:     127.0.0.1 …`),
 * supervisord's (`2026-11-22 12:00:00,123 INFO spawned …`) and Fluent Bit's
 * (`[2026/11/22 12:00:00] [ info] […]`).
 */

/** A routine line's level at its start, in each of the container's formats. */
const ROUTINE = [
  /^(?:DEBUG|INFO):/,
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d+ (?:DEBG|DEBUG|INFO) /,
  /^\[\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\] \[\s*(?:debug|info|trace)\]/,
];

/** Whether a Sump line is routine (logged as INFO) rather than an error. */
export function isRoutineSumpLine(line: string): boolean {
  return ROUTINE.some((r) => r.test(line));
}
