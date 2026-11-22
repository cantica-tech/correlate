/**
 * The events' calls to the window's Sump (REQ-000046-sJpO9KMY), through its
 * bridge only (br-CONN-000008-sJpO9KMY): the `/events` API of the Sump's
 * events plugin (Item 46) and an event's artifacts (Item 47). The app never
 * evaluates an event (decision D7).
 */
import type { SumpErrorInfo, SumpRequester } from "../shell/bridge.js";
import { sayError } from "../streams/api.js";

/** A metric condition, or a log one. */
export type Condition =
  | { type: "metric"; metric: "cpu" | "mem" | "net"; op: string; threshold: number }
  | { type: "log"; pattern: string };

/** What a firing does. */
export interface Action {
  kind: "none" | "snapshot" | "recording";
  minutes: number;
  keep_days: number;
}

/** When an event fires by the clock (REQ-000047-sJpO9KMY): once, or on cron, in a zone. */
export interface Schedule {
  kind: "none" | "once" | "cron";
  /** `once`: epoch ms. */
  at?: number | null;
  /** `cron`: five fields. */
  cron?: string;
  /** The IANA zone, e.g. `Europe/Paris`. */
  tz: string;
}

/** What the dialog sends: an event's definition. */
export interface EventSpec {
  name: string;
  stream: string;
  containers: string[];
  host: boolean;
  conditions: Condition[];
  match: "any" | "all";
  action: Action;
  schedule?: Schedule;
  enabled?: boolean;
}

/** An event, as the Sump answers it. */
export interface SumpEvent extends EventSpec {
  id: string;
  owner: string;
  version: number;
  enabled: boolean;
  status: "armed" | "triggered";
  trigger_count: number;
  trigger_detail: string | null;
  triggered_at: number | null;
  /** A schedule's next due time (epoch ms), or null. */
  next_due?: number | null;
  /** On a create or an edit: streams keeping less than a snapshot's window. */
  warnings?: string[];
}

/** An artifact, as the Sump answers it. */
export interface Artifact {
  id: string;
  event: string;
  kind: "snapshot" | "recording";
  status: "pending" | "complete" | "failed";
  from: number;
  to: number;
  created_at: number;
  expires_at: number | null;
  safe: boolean;
  size: number | null;
  reason: string | null;
}

/** An answer, or what went wrong in words. */
export type Answer<T> = { ok: true; value: T } | { ok: false; message: string; stale?: boolean };

/** A Sump refusal in the user's words: a stale edit says to reload. */
export function refused(error: SumpErrorInfo): Answer<never> {
  if (error.kind === "http" && error.status === 409)
    return {
      ok: false,
      stale: true,
      message: "The event was changed meanwhile: it is reloaded; edit it again",
    };
  return { ok: false, message: sayError(error) };
}

/** Call the Sump. */
async function call<T>(
  request: SumpRequester,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  extra: { body?: unknown; query?: Record<string, string | number> } = {},
): Promise<Answer<T>> {
  const reply = await request({ method, path, ...extra });
  if (!reply.ok) return refused(reply.error);
  return { ok: true, value: reply.value as T };
}

/** The user's events on the window's Sump. */
export async function listEvents(request: SumpRequester): Promise<Answer<SumpEvent[]>> {
  const r = await call<{ events: SumpEvent[] }>(request, "GET", "/events");
  return r.ok ? { ok: true, value: r.value.events } : r;
}

/** A new event; refused with the Sump's reason. */
export function createEvent(request: SumpRequester, spec: EventSpec): Promise<Answer<SumpEvent>> {
  return call(request, "POST", "/events", { body: spec });
}

/** An edit of `event`, based on its version. */
export function updateEvent(
  request: SumpRequester,
  event: SumpEvent,
  change: Partial<EventSpec>,
): Promise<Answer<SumpEvent>> {
  return call(request, "PUT", `/events/${encodeURIComponent(event.id)}`, {
    body: { ...change, version: event.version },
  });
}

/** Remove `event`, based on its version; its firings stay. */
export function deleteEvent(request: SumpRequester, event: SumpEvent): Promise<Answer<unknown>> {
  return call(request, "DELETE", `/events/${encodeURIComponent(event.id)}`, {
    query: { version: event.version },
  });
}

/** Re-arm `event` without waiting for its conditions to clear. */
export function resetEvent(request: SumpRequester, event: SumpEvent): Promise<Answer<SumpEvent>> {
  return call(request, "POST", `/events/${encodeURIComponent(event.id)}/reset`);
}

/** An event's artifacts, newest first. */
export async function listArtifacts(
  request: SumpRequester,
  event: SumpEvent,
): Promise<Answer<Artifact[]>> {
  const r = await call<{ artifacts: Artifact[] }>(
    request,
    "GET",
    `/events/${encodeURIComponent(event.id)}/artifacts`,
  );
  return r.ok ? { ok: true, value: r.value.artifacts } : r;
}

/** Keep an artifact `days` from now (at most 30). */
export function keepArtifact(
  request: SumpRequester,
  artifact: Artifact,
  days: number,
): Promise<Answer<Artifact>> {
  return call(request, "POST", `/artifacts/${artifact.id}/keep`, { body: { days } });
}

/** cttc's summary of an event's conditions: `cpu > 80 OR log ~ /ERROR/`. */
export function conditionsText(event: Pick<EventSpec, "conditions" | "match">): string {
  return event.conditions
    .map((c) =>
      c.type === "metric" ? `${c.metric} ${c.op} ${c.threshold}` : `log ~ /${c.pattern}/`,
    )
    .join(event.match === "all" ? " AND " : " OR ");
}

/** What makes an event fire, in words: its conditions, or its schedule. */
export function triggerText(event: Pick<EventSpec, "conditions" | "match" | "schedule">): string {
  const s = event.schedule;
  if (s?.kind === "cron") return `cron ${s.cron} (${s.tz})`;
  if (s?.kind === "once" && s.at != null)
    return `once at ${new Date(s.at).toLocaleString()} (${s.tz})`;
  return conditionsText(event);
}

/** The app's time zone, as the Sump keeps it with a schedule. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** cttc's summary of an action: `snapshot (last 5m)`, `record 10m`. */
export function actionText(action: Action): string {
  if (action.kind === "snapshot") return `snapshot (last ${action.minutes}m)`;
  if (action.kind === "recording") return `record ${action.minutes}m`;
  return "no action";
}
