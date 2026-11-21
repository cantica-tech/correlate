/**
 * The log panels' parity data (REQ-000029-sJpO9KMY Requirement 5), the same
 * on cttc's page and ours: a container's rows, one an error and one a warning.
 */

/** The container. */
export const LOG_NAME = "web";

/** Its rows, newest first, as the Sump answers. */
export const LOG_ROWS = [
  "GET /api/items 200 12ms",
  "WARN slow query on items: 840ms",
  "GET /api/items/7 200 4ms",
  "ERROR upstream db timed out after 5000ms",
  "POST /api/items 201 18ms",
  "GET /health 200 1ms",
  "GET /api/items 200 9ms",
  "GET /api/users 200 7ms",
].map((text, i) => ({
  ts: new Date(Date.UTC(2026, 10, 21, 18, 9, 59 - i * 3, 125)).toISOString(),
  text,
}));

/** The cursor: at the error row's time; rows within 5 s of it are highlighted. */
export const LOG_CURSOR_INDEX = 3;
export const LOG_CURSOR_T = Date.parse(LOG_ROWS[LOG_CURSOR_INDEX]?.ts ?? "");
/** The rows within cttc's 5 s highlight window of the cursor. */
export const LOG_HIGHLIGHTED = LOG_ROWS.map((r, i) => [i, Date.parse(r.ts)] as const)
  .filter(([, t]) => Math.abs(t - LOG_CURSOR_T) <= 5_000)
  .map(([i]) => i);
