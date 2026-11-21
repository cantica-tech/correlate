/**
 * The renderer's only way to a Sump (br-CONN-000008-sJpO9KMY,
 * REQ-000007-sJpO9KMY Requirement 3): the `sump:request` IPC channel.
 *
 * The renderer names a Sump, a method and a path; it never gives a URL, so it
 * cannot reach a host that is not a configured Sump. Answers and errors come
 * back as plain objects, since class instances do not survive IPC.
 */

import type { Lifecycle } from "../catalog/lifecycle.js";
import type { ActiveSumps } from "../catalog/windows.js";
import { type Method, request } from "./client.js";
import { type Sump, SumpCallError, SumpHttpError, SumpTimeoutError } from "./errors.js";
import type { SessionTokens } from "./tokens.js";

/** The IPC channel the main process answers. */
export const SUMP_REQUEST_CHANNEL = "sump:request";

/** The IPC channel that says which Sump the calling window is on (br-SUMP-000010). */
export const SUMP_ACTIVE_CHANNEL = "sump:active";

/** The IPC channel that lists every Sump's lifecycle state (br-SUMP-000011). */
export const SUMP_STATES_CHANNEL = "sump:states";

/** The channel each lifecycle change is pushed to every window on. */
export const SUMP_STATE_EVENT = "sump:state";

/**
 * Tell the lifecycle what a call's outcome says about the Sump
 * (br-SUMP-000011): an answer, whatever its status, means it is there; a
 * timeout or network error that it is not. A refused call says nothing.
 */
export function observeOutcome(lifecycle: Lifecycle, sump: string, error?: unknown): void {
  if (error === undefined) lifecycle.reachable(sump, "answered a call");
  else if (error instanceof SumpHttpError) lifecycle.reachable(sump, `answered ${error.status}`);
  else if (error instanceof SumpTimeoutError) lifecycle.unreachable(sump, error.message);
  else if (!(error instanceof SumpCallError)) {
    lifecycle.unreachable(
      sump,
      `no answer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const METHODS: readonly Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** What the renderer sends; without `sump`, the call goes to the window's active Sump. */
export interface SumpRequestMessage {
  sump: string;
  method: Method;
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean>;
  timeoutMs?: number;
}

/** A failure as the renderer receives it. */
export type SumpErrorInfo =
  | { kind: "timeout"; message: string; limit: "total" | "idle"; limitMs: number }
  | { kind: "http"; message: string; status: number; detail: unknown }
  | { kind: "login-needed"; message: string }
  | { kind: "refused" | "network"; message: string };

/** What the renderer receives. */
export type SumpReply<T = unknown> = { ok: true; value: T } | { ok: false; error: SumpErrorInfo };

/** The part of Electron's `ipcMain` this module uses. */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcEventLike, message: unknown) => Promise<unknown> | unknown,
  ): void;
}

/** The part of an IPC event this module uses: which window sent it. */
export interface IpcEventLike {
  sender?: { id: number };
}

/** Finds a configured Sump by name. */
export type SumpResolver = (name: string) => Sump | undefined;

/** A plain-object description of any error a call can end with. */
export function describeError(error: unknown): SumpErrorInfo {
  if (error instanceof SumpTimeoutError) {
    return {
      kind: "timeout",
      message: error.message,
      limit: error.limit,
      limitMs: error.limitMs,
    };
  }
  if (error instanceof SumpHttpError && error.status === 401) {
    return { kind: "login-needed", message: error.message };
  }
  if (error instanceof SumpHttpError) {
    return { kind: "http", message: error.message, status: error.status, detail: error.detail };
  }
  if (error instanceof SumpCallError) return { kind: "refused", message: error.message };
  return { kind: "network", message: error instanceof Error ? error.message : String(error) };
}

/**
 * Check a message's shape; the renderer is not trusted to send a valid one.
 * A message without `sump` goes to `defaultSump`, the window's active Sump.
 */
function parse(message: unknown, defaultSump?: string): SumpRequestMessage {
  const m = { ...((message ?? {}) as Partial<SumpRequestMessage>) };
  if (m.sump === undefined && defaultSump !== undefined) m.sump = defaultSump;
  if (typeof m.sump !== "string") throw new SumpCallError("sump must be a Sump name");
  if (!METHODS.includes(m.method as Method)) {
    throw new SumpCallError(`method must be one of ${METHODS.join(", ")}`);
  }
  if (typeof m.path !== "string") throw new SumpCallError("path must be a string");
  if (m.timeoutMs !== undefined && typeof m.timeoutMs !== "number") {
    throw new SumpCallError("timeoutMs must be a number");
  }
  if (m.query !== undefined && (typeof m.query !== "object" || m.query === null)) {
    throw new SumpCallError("query must be an object");
  }
  return m as SumpRequestMessage;
}

/** Logs in to the named Sump again (the SSH-key login); throws when it cannot. */
export type Relogin = (sump: string) => Promise<void>;

/**
 * Answer one renderer request; never throws. A Sump refusing the token (401)
 * makes the main process forget it, log in once (`relogin`) and retry the
 * call once (br-CONN-000004-sJpO9KMY); a second refusal, or a failed login,
 * reaches the renderer as `login-needed`.
 */
export async function handleSumpRequest(
  message: unknown,
  resolve: SumpResolver,
  tokens?: SessionTokens,
  relogin?: Relogin,
  defaultSump?: string,
  lifecycle?: Lifecycle,
): Promise<SumpReply> {
  let m: SumpRequestMessage;
  try {
    m = parse(message, defaultSump);
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
  const send = async () => {
    const sump = resolve(m.sump);
    if (!sump) throw new SumpCallError(`no Sump named "${m.sump}"`);
    try {
      const value = await request(sump, m.method, m.path, {
        body: m.body,
        query: m.query,
        timeoutMs: m.timeoutMs,
      });
      if (lifecycle) observeOutcome(lifecycle, m.sump);
      return value;
    } catch (error) {
      if (lifecycle) observeOutcome(lifecycle, m.sump, error);
      throw error;
    }
  };
  try {
    return { ok: true, value: await send() };
  } catch (error) {
    if (!(error instanceof SumpHttpError && error.status === 401)) {
      return { ok: false, error: describeError(error) };
    }
    tokens?.forget(error.sump);
    if (!relogin) return { ok: false, error: describeError(error) };
    try {
      await relogin(m.sump);
    } catch (loginError) {
      tokens?.forget(m.sump);
      const why = loginError instanceof Error ? loginError.message : String(loginError);
      return { ok: false, error: { kind: "login-needed", message: `login failed: ${why}` } };
    }
    try {
      return { ok: true, value: await send() };
    } catch (retryError) {
      if (retryError instanceof SumpHttpError && retryError.status === 401) {
        tokens?.forget(retryError.sump);
      }
      return { ok: false, error: describeError(retryError) };
    }
  }
}

/**
 * Answer `sump:request` in the main process, `sump:active` when windows'
 * active Sumps are tracked (`active`: a request without `sump` goes to the
 * calling window's Sump), and `sump:states` when the lifecycle is
 * (`lifecycle`, which every call's outcome also updates).
 */
export function registerSumpIpc(
  ipcMain: IpcMainLike,
  resolve: SumpResolver,
  tokens?: SessionTokens,
  relogin?: Relogin,
  active?: ActiveSumps,
  lifecycle?: Lifecycle,
): void {
  const windowOf = (event: IpcEventLike) => event?.sender?.id ?? -1;
  ipcMain.handle(SUMP_REQUEST_CHANNEL, (event, message) =>
    handleSumpRequest(message, resolve, tokens, relogin, active?.get(windowOf(event)), lifecycle),
  );
  if (active) {
    ipcMain.handle(SUMP_ACTIVE_CHANNEL, (event) => active.describe(windowOf(event)));
  }
  if (lifecycle) {
    // Read-only: nothing on the bridge sets a state (br-SUMP-000011).
    ipcMain.handle(SUMP_STATES_CHANNEL, () => lifecycle.states());
  }
}
