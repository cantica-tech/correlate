/**
 * The Sump client: the only code in correlate-app that talks to a Sump
 * (br-CONN-000008-sJpO9KMY). It runs in the Electron main process; the
 * renderer reaches it through the preload bridge.
 *
 * Every call is bound by a time limit (br-CONN-000005-sJpO9KMY,
 * REQ-000007-sJpO9KMY Requirement 2):
 * - `request`: a total limit, 30 s by default, answer included.
 * - `download`: an idle limit, 30 s by default, between any two chunks.
 * - `stream`: an idle limit of 45 s, which the Sump's 15 s heartbeat keeps a
 *   quiet but healthy stream inside (br-CONN-000009-sJpO9KMY).
 * A call that runs past its limit is aborted and fails with
 * `SumpTimeoutError`. This replaces cttc's helpers, which other code
 * bypassed with no limit at all (cttc BUG-000020-uKKrzikI).
 */
import {
  checkedLimit,
  DOWNLOAD_IDLE_MS,
  type LimitKind,
  REQUEST_TIMEOUT_MS,
  STREAM_IDLE_MS,
  type Sump,
  SumpCallError,
  SumpHttpError,
  SumpTimeoutError,
} from "./errors.js";
import { SseParser, type SumpEvent } from "./sse.js";

export type { Sump, SumpEvent };

/** HTTP methods the Sump answers. */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Where timeouts are reported (the main process's console outside tests). */
export interface Logger {
  warn(message: string): void;
}

/** Options every call takes. */
interface CallOptions {
  /** Query parameters added to the path. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Where timeouts are logged; the console by default. */
  logger?: Logger;
}

/** Options for `request`. */
export interface RequestOptions extends CallOptions {
  /** Sent as JSON. */
  body?: unknown;
  /** Total limit in milliseconds; `REQUEST_TIMEOUT_MS` by default. */
  timeoutMs?: number;
}

/** Options for `download`. */
export interface DownloadOptions extends CallOptions {
  /** Longest wait for the next bytes in milliseconds; `DOWNLOAD_IDLE_MS` by default. */
  idleMs?: number;
}

/** Options for `stream`. */
export interface StreamOptions extends CallOptions {
  /** Longest silence in milliseconds; `STREAM_IDLE_MS` by default. */
  idleMs?: number;
}

/** An open event stream. */
export interface SumpStream {
  /** Stop the stream; `done` then resolves. */
  close(): void;
  /** Resolves when the stream ends or is closed; rejects on a timeout or an error. */
  done: Promise<void>;
}

/**
 * The URL for a path on a Sump. The path must be absolute on the Sump
 * itself: one that would lead to another host is refused.
 */
export function sumpUrl(sump: Sump, path: string, query?: CallOptions["query"]): URL {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new SumpCallError(`a Sump path must start with a single "/", got "${path}"`);
  }
  const base = new URL(sump.baseUrl);
  const url = new URL(path, base);
  if (url.origin !== base.origin) {
    throw new SumpCallError(`path "${path}" leads away from Sump "${sump.name}"`);
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

/**
 * A timer that aborts a call: `arm` (re)starts it, `clear` stops it, and
 * `timedOut` says whether it fired. Each call owns one, so aborting one call
 * never touches another.
 */
class Deadline {
  readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  timedOut = false;

  constructor(
    private readonly limitMs: number,
    private readonly onTimeout: () => void,
  ) {}

  arm(): void {
    this.clear();
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.onTimeout();
      this.controller.abort();
    }, this.limitMs);
  }

  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** Everything one call needs to report itself. */
class Call {
  readonly deadline: Deadline;

  constructor(
    readonly sump: Sump,
    readonly method: Method,
    readonly path: string,
    readonly limit: LimitKind,
    readonly limitMs: number,
    logger: Logger,
  ) {
    this.deadline = new Deadline(limitMs, () => logger.warn(this.timeout().message));
  }

  timeout(): SumpTimeoutError {
    return new SumpTimeoutError(this.sump.name, this.method, this.path, this.limit, this.limitMs);
  }

  /** The error to throw: a timeout when the deadline fired, else the original. */
  failure(error: unknown): unknown {
    return this.deadline.timedOut ? this.timeout() : error;
  }

  /** Throws `SumpHttpError` for a status outside 2xx, with the Sump's `detail`. */
  async check(response: Response): Promise<void> {
    if (response.ok) return;
    let detail: unknown;
    try {
      const text = await response.text();
      try {
        detail = (JSON.parse(text) as { detail?: unknown }).detail ?? text;
      } catch {
        detail = text;
      }
    } catch {
      detail = undefined;
    }
    throw new SumpHttpError(this.sump.name, this.method, this.path, response.status, detail);
  }
}

/**
 * Send one request and return its JSON answer (or `undefined` when empty).
 * The whole call, answer included, must finish within `timeoutMs`.
 */
export async function request<T = unknown>(
  sump: Sump,
  method: Method,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const limitMs = checkedLimit(options.timeoutMs, REQUEST_TIMEOUT_MS, "timeoutMs");
  const url = sumpUrl(sump, path, options.query);
  const call = new Call(sump, method, path, "total", limitMs, options.logger ?? console);
  const init: RequestInit = { method, signal: call.deadline.controller.signal };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { "content-type": "application/json" };
  }
  call.deadline.arm();
  try {
    const response = await fetch(url, init);
    await call.check(response);
    const text = await response.text();
    return (text === "" ? undefined : JSON.parse(text)) as T;
  } catch (error) {
    throw call.failure(error);
  } finally {
    call.deadline.clear();
  }
}

/**
 * Fetch a body chunk by chunk, handing each to `onChunk`. There is no limit
 * on the whole download, only on the wait for its next bytes: a long but
 * steady download completes, a stalled one fails.
 */
export async function download(
  sump: Sump,
  path: string,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  options: DownloadOptions = {},
): Promise<void> {
  const limitMs = checkedLimit(options.idleMs, DOWNLOAD_IDLE_MS, "idleMs");
  const url = sumpUrl(sump, path, options.query);
  const call = new Call(sump, "GET", path, "idle", limitMs, options.logger ?? console);
  await readBody(call, url, async (chunk) => {
    // Time spent handling a chunk is ours, not the Sump's.
    call.deadline.clear();
    await onChunk(chunk);
    call.deadline.arm();
  });
}

/**
 * Open a server-sent event stream and hand each event to `onEvent`. Any
 * bytes, heartbeats included, count as signs of life; `idleMs` without any
 * fails the stream.
 */
export function stream(
  sump: Sump,
  path: string,
  onEvent: (event: SumpEvent) => void,
  options: StreamOptions = {},
): SumpStream {
  const limitMs = checkedLimit(options.idleMs, STREAM_IDLE_MS, "idleMs");
  const url = sumpUrl(sump, path, options.query);
  const call = new Call(sump, "GET", path, "idle", limitMs, options.logger ?? console);
  const parser = new SseParser();
  let closed = false;
  const done = readBody(call, url, (chunk) => {
    for (const event of parser.push(chunk)) {
      if (closed) return;
      onEvent(event);
    }
  }).catch((error: unknown) => {
    if (!closed) throw error;
  });
  return {
    close() {
      closed = true;
      call.deadline.clear();
      call.deadline.controller.abort();
    },
    done,
  };
}

/** GET `url` and read its body, the deadline re-armed on every chunk. */
async function readBody(
  call: Call,
  url: URL,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
): Promise<void> {
  call.deadline.arm();
  try {
    const response = await fetch(url, { signal: call.deadline.controller.signal });
    await call.check(response);
    if (!response.body) return;
    const reader = response.body.getReader();
    for (;;) {
      call.deadline.arm();
      const { done, value } = await reader.read();
      if (done) return;
      await onChunk(value);
    }
  } catch (error) {
    throw call.failure(error);
  } finally {
    call.deadline.clear();
  }
}
