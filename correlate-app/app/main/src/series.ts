/**
 * The containers' order and hidden set, per Sump and stream
 * (REQ-000030-sJpO9KMY Requirement 4, decided in FEAT-000031-sJpO9KMY): what
 * the legend and the log panels show, in which order, kept in the settings
 * file under `series` so every window on that stream shares them and they
 * survive a restart (br-STREAM-000001-sJpO9KMY: the active stream's only).
 *
 * - `series:get` (stream id): `{ order, hidden }` on the window's Sump.
 * - `series:set` (`{ stream, order, hidden }`): keep them.
 */
import type { ActiveSumps } from "./catalog/windows.js";
import type { IpcEventLike, IpcMainLike } from "./sump/ipc.js";
import type { Settings } from "./theme.js";

export const SERIES_GET_CHANNEL = "series:get";
export const SERIES_SET_CHANNEL = "series:set";

const PART = "series";
/** A name or id: printable, at most 200 characters. */
const NAME = /^[\x21-\x7e]{1,200}$/;
/** At most this many names in a list, and streams kept. */
const MAX_NAMES = 500;
const MAX_STREAMS = 200;

/** One stream's arrangement. */
export interface Arrangement {
  order: string[];
  hidden: string[];
}

/** Names only: printable, unique, at most `MAX_NAMES`; throws otherwise. */
function names(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_NAMES) {
    throw new Error(`${what} is a list of at most ${MAX_NAMES} names`);
  }
  for (const v of value) {
    if (typeof v !== "string" || !NAME.test(v)) {
      throw new Error(`${what} holds names of up to 200 printable characters`);
    }
  }
  return [...new Set(value as string[])];
}

/** The key of a stream on a Sump. */
function keyOf(sump: string, stream: string): string {
  return `${sump}|${stream}`;
}

function saved(settings: Settings): Record<string, Arrangement> {
  const part = settings.part(PART);
  if (typeof part !== "object" || part === null || Array.isArray(part)) return {};
  const out: Record<string, Arrangement> = {};
  for (const [key, value] of Object.entries(part)) {
    try {
      const v = value as Partial<Arrangement>;
      out[key] = { order: names(v.order, "order"), hidden: names(v.hidden, "hidden") };
    } catch {
      // A damaged entry is dropped, the others kept.
    }
  }
  return out;
}

/** The arrangement of `stream` on `sump`; empty when none is kept. */
export function arrangement(settings: Settings, sump: string, stream: unknown): Arrangement {
  if (typeof stream !== "string" || !NAME.test(stream)) return { order: [], hidden: [] };
  return saved(settings)[keyOf(sump, stream)] ?? { order: [], hidden: [] };
}

/** Keep `message` (`{ stream, order, hidden }`) for `sump`; throws on anything else. */
export function setArrangement(settings: Settings, sump: string, message: unknown): Arrangement {
  const m = (message ?? {}) as Record<string, unknown>;
  if (typeof m.stream !== "string" || !NAME.test(m.stream)) {
    throw new Error("stream is an id of up to 200 printable characters");
  }
  const next = { order: names(m.order, "order"), hidden: names(m.hidden, "hidden") };
  const all = saved(settings);
  const key = keyOf(sump, m.stream);
  delete all[key];
  all[key] = next;
  // The oldest streams go first past the limit.
  const keys = Object.keys(all);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_STREAMS))) delete all[old];
  settings.setPart(PART, all);
  return next;
}

/** Answer the two channels for the calling window's Sump. */
export function registerSeriesIpc(
  ipcMain: IpcMainLike,
  settings: Settings,
  sumps: Pick<ActiveSumps, "get">,
): void {
  const sumpOf = (event: IpcEventLike) => sumps.get(event?.sender?.id ?? -1);
  ipcMain.handle(SERIES_GET_CHANNEL, (event, stream) => {
    const sump = sumpOf(event);
    return sump ? arrangement(settings, sump, stream) : { order: [], hidden: [] };
  });
  ipcMain.handle(SERIES_SET_CHANNEL, (event, message) => {
    const sump = sumpOf(event);
    if (!sump) return { ok: false, message: "this window has no Sump" };
    try {
      return { ok: true, arrangement: setArrangement(settings, sump, message) };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });
}
