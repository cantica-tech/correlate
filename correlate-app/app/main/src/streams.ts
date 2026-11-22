/**
 * Each window's active data stream (REQ-000027-sJpO9KMY Requirement 3,
 * decided in FEAT-000028-sJpO9KMY): the one its views show
 * (br-STREAM-000001-sJpO9KMY), kept by the main process like the window's
 * active Sump (br-SUMP-000010-sJpO9KMY). It belongs to the Sump it was set
 * on: after the window moves to another Sump it has none until one is set.
 * The renderer heals it (to the picker's last stream, "self" or the first)
 * when it has none or its stream is gone.
 */
import type { ActiveSumps } from "./catalog/windows.js";
import { abandonIfLive, confirmNeeded, type SwitchGuard } from "./provision/local.js";
import type { IpcEventLike, IpcMainLike } from "./sump/ipc.js";

export const STREAM_ACTIVE_CHANNEL = "stream:active";
export const STREAM_SET_ACTIVE_CHANNEL = "stream:setActive";

/** A stream id: printable, at most 200 characters. */
const ID = /^[\x21-\x7e]{1,200}$/;

/** The active stream of each window, with the Sump it was set on. */
export class ActiveStreams {
  private readonly byWindow = new Map<number, { sump: string; stream: string }>();

  /** The window's active stream on `sump`, or null. */
  get(windowId: number, sump: string | undefined): string | null {
    const entry = this.byWindow.get(windowId);
    return entry && sump && entry.sump === sump ? entry.stream : null;
  }

  /** Make `stream` the window's active stream on `sump`; throws on a bad id. */
  set(windowId: number, sump: string, stream: unknown): string {
    if (typeof stream !== "string" || !ID.test(stream)) {
      throw new Error("a stream id is up to 200 printable characters");
    }
    this.byWindow.set(windowId, { sump, stream });
    return stream;
  }

  /** A window closed. */
  close(windowId: number): void {
    this.byWindow.delete(windowId);
  }
}

/**
 * Answer `stream:active` and `stream:setActive` for the calling window, on
 * its active Sump; a window with no Sump has no active stream. While a
 * recording is live, changing the stream answers "confirm" unless the call
 * is confirmed (`{ stream, confirmed: true }`), which abandons the recording first
 * (br-REC-000001-sJpO9KMY, REQ-000039-sJpO9KMY).
 */
export function registerStreamIpc(
  ipcMain: IpcMainLike,
  streams: ActiveStreams,
  sumps: Pick<ActiveSumps, "get">,
  guard?: SwitchGuard,
): void {
  const windowOf = (event: IpcEventLike) => event?.sender?.id ?? -1;
  ipcMain.handle(STREAM_ACTIVE_CHANNEL, (event) => {
    const window = windowOf(event);
    return streams.get(window, sumps.get(window));
  });
  ipcMain.handle(STREAM_SET_ACTIVE_CHANNEL, async (event, message) => {
    // A stream id, or `{ stream, confirmed }` once the user confirmed.
    const m = message as { stream?: unknown; confirmed?: unknown } | null;
    const confirmed = typeof message === "object" && m?.confirmed === true;
    const stream = typeof message === "object" && m !== null ? m.stream : message;
    const window = windowOf(event);
    const sump = sumps.get(window);
    if (!sump) return { ok: false, message: "this window has no Sump" };
    // A window's first stream (after a switch, at start) changes nothing recorded.
    const current = streams.get(window, sump);
    if (current !== null && stream !== current) {
      const ask = confirmNeeded(guard, confirmed);
      if (ask) return ask;
      await abandonIfLive(guard);
    }
    try {
      return { ok: true, stream: streams.set(window, sump, stream) };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });
}
