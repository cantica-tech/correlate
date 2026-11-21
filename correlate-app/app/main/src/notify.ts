/**
 * Notifications and their History (REQ-000022-sJpO9KMY Requirement 2), kept
 * by the main process, in memory, so every window and the detached sidebar
 * see one feed and a reloaded window keeps it (decided in
 * FEAT-000023-sJpO9KMY); lost on quit, as cttc's was. At most 500 entries,
 * cttc's cap (`STATUS_BAR_HISTORY_MAX`); each one plain text.
 *
 * A Sump some window is on that is lost or comes back is notified, once per
 * change, as cttc's pill did ("Gateway connection failed", "restored"). The
 * status bar's visibility is remembered beside the theme.
 */
import type { Lifecycle, StateRecord } from "./catalog/lifecycle.js";
import type { IpcMainLike } from "./sump/ipc.js";
import type { Settings } from "./theme.js";

/** At most this many entries are kept; the oldest go first. */
export const HISTORY_MAX = 500;
/** A message is at most this long. */
export const TEXT_MAX = 500;

/** One notification. */
export interface Notice {
  /** When, as an ISO time. */
  at: string;
  text: string;
}

/** What windows hear. */
export type NoticeEvent = { type: "entry"; entry: Notice } | { type: "cleared" };

/** The IPC channels of the status bar. */
export const STATUS_HISTORY_CHANNEL = "status:history";
export const STATUS_ADD_CHANNEL = "status:add";
export const STATUS_CLEAR_CHANNEL = "status:clear";
export const STATUS_VISIBLE_CHANNEL = "status:visible";
export const STATUS_SET_VISIBLE_CHANNEL = "status:setVisible";
/** Sent to every window: a `NoticeEvent`. */
export const STATUS_NOTICE_EVENT = "status:notice";
/** Sent to every window: whether the bar is shown. */
export const STATUS_VISIBILITY_EVENT = "status:visibility";

/** The feed. */
export class Notifications {
  private readonly entries: Notice[] = [];
  private readonly listeners = new Set<(event: NoticeEvent) => void>();

  constructor(
    private readonly logger: { info(message: string): void } = console,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Add a message; throws on anything but non-empty text of at most 500 characters. */
  add(text: unknown): Notice {
    if (typeof text !== "string" || text.trim() === "") throw new Error("a notification is text");
    if (text.length > TEXT_MAX) throw new Error(`a notification is at most ${TEXT_MAX} characters`);
    const entry = { at: this.now().toISOString(), text };
    this.entries.push(entry);
    if (this.entries.length > HISTORY_MAX) this.entries.shift();
    this.logger.info(`notification: ${text}`);
    this.emit({ type: "entry", entry });
    return entry;
  }

  /** Every entry, oldest first. */
  list(): Notice[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Forget every entry. */
  clear(): void {
    this.entries.length = 0;
    this.emit({ type: "cleared" });
  }

  /** Hear each entry and each clear; returns the function that stops listening. */
  subscribe(listener: (event: NoticeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: NoticeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/**
 * Notify a Sump in use that is lost, and the same Sump when it comes back.
 * A Sump that starts unreachable and then answers is not "restored": nothing
 * was said about it being lost.
 */
export function notifyLifecycle(
  lifecycle: Lifecycle,
  notifications: Notifications,
  inUse: (id: string) => boolean,
  nameOf: (id: string) => string,
): () => void {
  const previous = new Map(lifecycle.states().map((r) => [r.id, r.state]));
  const lost = new Set<string>();
  return lifecycle.subscribe((record: StateRecord) => {
    const before = previous.get(record.id);
    previous.set(record.id, record.state);
    if (before === "active" && record.state === "unreachable" && inUse(record.id)) {
      lost.add(record.id);
      notifications.add(
        `Sump ${nameOf(record.id)} connection lost: ${record.reason}`.slice(0, TEXT_MAX),
      );
    } else if (record.state === "active" && lost.delete(record.id)) {
      notifications.add(`Sump ${nameOf(record.id)} connection restored`);
    } else if (record.state === "retired") {
      lost.delete(record.id);
    }
  });
}

/** Whether the status bar is shown: by default yes, as in cttc. */
export function statusBarVisible(settings: Settings): boolean {
  const saved = settings.part("statusBar") as { visible?: unknown } | undefined;
  return typeof saved?.visible === "boolean" ? saved.visible : true;
}

/**
 * Answer the status bar's bridge and send every notice and visibility change
 * to every window through `broadcast`.
 */
export function registerStatusIpc(
  ipcMain: IpcMainLike,
  notifications: Notifications,
  settings: Settings,
  broadcast: (channel: string, value: unknown) => void,
): () => void {
  ipcMain.handle(STATUS_HISTORY_CHANNEL, () => notifications.list());
  ipcMain.handle(STATUS_ADD_CHANNEL, (_event, text) => {
    try {
      return { ok: true, entry: notifications.add(text) };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });
  ipcMain.handle(STATUS_CLEAR_CHANNEL, () => {
    notifications.clear();
    return { ok: true };
  });
  ipcMain.handle(STATUS_VISIBLE_CHANNEL, () => statusBarVisible(settings));
  ipcMain.handle(STATUS_SET_VISIBLE_CHANNEL, (_event, visible) => {
    if (typeof visible !== "boolean") return { ok: false, message: "visible is true or false" };
    settings.setPart("statusBar", { visible });
    broadcast(STATUS_VISIBILITY_EVENT, visible);
    return { ok: true, visible };
  });
  return notifications.subscribe((event) => broadcast(STATUS_NOTICE_EVENT, event));
}
