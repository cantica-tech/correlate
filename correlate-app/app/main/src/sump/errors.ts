/**
 * What a Sump call can fail with, and the limits every call is bound by
 * (br-CONN-000005-sJpO9KMY, REQ-000007-sJpO9KMY Requirement 2).
 */

/** A Sump as the client sees it: a name for messages and the URL it answers on. */
export interface Sump {
  /** Shown in errors and logs, e.g. "local" or the Sump's catalog name. */
  name: string;
  /** Where the Sump answers: a loopback port, or an SSH forward to one (D4). */
  baseUrl: string;
}

/** Total time for a plain request, answer included, unless the call says otherwise. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Longest wait for the next bytes of a download, unless the call says otherwise. */
export const DOWNLOAD_IDLE_MS = 30_000;
/** Longest silence on an event stream: three missed Sump heartbeats (br-CONN-000009). */
export const STREAM_IDLE_MS = 45_000;
/** The longest delay a timer can hold; above it Node fires at once. */
export const MAX_LIMIT_MS = 2 ** 31 - 1;

/** Whether a call hit its limit for the whole call, or waited too long for the next bytes. */
export type LimitKind = "total" | "idle";

/** A call that ran past its time limit; its connection has been aborted. */
export class SumpTimeoutError extends Error {
  override readonly name = "SumpTimeoutError";

  constructor(
    readonly sump: string,
    readonly method: string,
    readonly path: string,
    readonly limit: LimitKind,
    readonly limitMs: number,
  ) {
    const what = limit === "total" ? "did not complete within" : "sent nothing for";
    super(`Sump "${sump}": ${method} ${path} ${what} ${limitMs} ms`);
  }
}

/** A Sump that answered with an error status; `detail` is its explanation, if any. */
export class SumpHttpError extends Error {
  override readonly name = "SumpHttpError";

  constructor(
    readonly sump: string,
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly detail: unknown,
  ) {
    const why = typeof detail === "string" ? `: ${detail}` : "";
    super(`Sump "${sump}": ${method} ${path} answered ${status}${why}`);
  }
}

/** A call the client refused to send, such as one without a valid time limit. */
export class SumpCallError extends Error {
  override readonly name = "SumpCallError";
}

/**
 * The limit a call runs with: the default when none is given, otherwise a
 * positive whole number of milliseconds a timer can hold. Zero, negative,
 * infinite or `NaN` limits are refused, so no call can be unbounded.
 */
export function checkedLimit(value: number | undefined, fallback: number, what: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > MAX_LIMIT_MS) {
    throw new SumpCallError(
      `${what} must be between 1 and ${MAX_LIMIT_MS} milliseconds, got ${value}`,
    );
  }
  return Math.ceil(value);
}
