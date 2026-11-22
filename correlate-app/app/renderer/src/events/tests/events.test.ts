/**
 * The app's side of events (REQ-000046-sJpO9KMY Requirement 3): the Sump's
 * `/events` API called with versions, its refusals in words (a stale edit
 * flagged to reload), cttc's summaries, and the form's checks.
 */
import { describe, expect, it } from "vitest";
import type { SumpRequester } from "../../shell/bridge.js";
import {
  actionText,
  conditionsText,
  createEvent,
  deleteEvent,
  listEvents,
  type SumpEvent,
  triggerText,
  updateEvent,
} from "../api.js";
import { conditionsOf } from "../EventFormDialog.js";
import { artifactText } from "../EventListDialog.js";

const event = {
  id: "evt-1",
  version: 3,
  name: "busy",
  stream: "self",
  containers: [],
  host: false,
  conditions: [
    { type: "metric", metric: "cpu", op: ">", threshold: 80 },
    { type: "log", pattern: "ERROR|FATAL" },
  ],
  match: "any",
  action: { kind: "snapshot", minutes: 5, keep_days: 0 },
} as unknown as SumpEvent;

/** A Sump answering `reply`, and the calls it got. */
function sump(reply: Awaited<ReturnType<SumpRequester>>) {
  const calls: unknown[] = [];
  const request: SumpRequester = async (m) => {
    calls.push(m);
    return reply;
  };
  return { request, calls };
}

describe("REQ-000046-sJpO9KMY: the events API from the app", () => {
  it("sends edits and deletes with the version they are based on", async () => {
    const s = sump({ ok: true, value: {} });
    await updateEvent(s.request, event, { enabled: false });
    await deleteEvent(s.request, event);
    expect(s.calls).toEqual([
      { method: "PUT", path: "/events/evt-1", body: { enabled: false, version: 3 } },
      { method: "DELETE", path: "/events/evt-1", query: { version: 3 } },
    ]);
  });

  it("says the Sump's reason, and flags a stale edit to reload", async () => {
    const invalid = sump({
      ok: false,
      error: {
        kind: "http",
        message: "HTTP 422",
        status: 422,
        detail: { detail: "invalid regex '(': x" },
      },
    });
    expect(await createEvent(invalid.request, event)).toEqual({
      ok: false,
      message: "invalid regex '(': x",
    });
    const stale = sump({
      ok: false,
      error: { kind: "http", message: "HTTP 409", status: 409, detail: { detail: "version 4" } },
    });
    expect(await updateEvent(stale.request, event, {})).toMatchObject({ ok: false, stale: true });
  });

  it("lists the events the Sump answers", async () => {
    const s = sump({ ok: true, value: { events: [event] } });
    expect(await listEvents(s.request)).toEqual({ ok: true, value: [event] });
  });

  it("summarizes as cttc's rows", () => {
    expect(conditionsText(event)).toBe("cpu > 80 OR log ~ /ERROR|FATAL/");
    expect(conditionsText({ ...event, match: "all" })).toBe("cpu > 80 AND log ~ /ERROR|FATAL/");
    expect(actionText({ kind: "recording", minutes: 10, keep_days: 0 })).toBe("record 10m");
    expect(actionText(event.action)).toBe("snapshot (last 5m)");
  });

  it("says what makes an event fire: its conditions, or its schedule (REQ-000047)", () => {
    expect(triggerText(event)).toBe("cpu > 80 OR log ~ /ERROR|FATAL/");
    expect(
      triggerText({ ...event, schedule: { kind: "cron", cron: "0 2 * * *", tz: "Europe/Paris" } }),
    ).toBe("cron 0 2 * * * (Europe/Paris)");
    expect(
      triggerText({ ...event, schedule: { kind: "once", at: Date.UTC(2026, 11, 1), tz: "UTC" } }),
    ).toMatch(/^once at .+ \(UTC\)$/);
  });

  it("says an artifact's state, and why a failed one failed", () => {
    const base = {
      id: "a",
      event: "e",
      kind: "snapshot",
      from: 0,
      to: 0,
      created_at: 0,
      expires_at: 0,
    } as const;
    expect(
      artifactText({ ...base, status: "complete", safe: true, size: 1_200_000, reason: null }),
    ).toMatch(/^snapshot · complete · \d\d:\d\d:\d\d\.000 · 1\.2 MB · kept$/);
    expect(
      artifactText({ ...base, status: "failed", safe: false, size: null, reason: "data gone" }),
    ).toMatch(/^snapshot · failed \(data gone\) · /);
  });
});

describe("REQ-000046-sJpO9KMY: the form's checks, as cttc's", () => {
  const row = {
    key: 1,
    type: "metric" as const,
    metric: "cpu" as const,
    op: ">",
    threshold: "80",
    pattern: "",
  };

  it("turns rows into conditions", () => {
    expect(conditionsOf([row, { ...row, key: 2, type: "log", pattern: "ERR" }])).toEqual([
      { type: "metric", metric: "cpu", op: ">", threshold: 80 },
      { type: "log", pattern: "ERR" },
    ]);
  });

  it("refuses none, a blank or wrong threshold, and a regex that does not compile", () => {
    expect(conditionsOf([])).toBe("add at least one condition");
    expect(conditionsOf([{ ...row, threshold: "" }])).toBe("threshold must be a valid number");
    expect(conditionsOf([{ ...row, threshold: "high" }])).toBe("threshold must be a valid number");
    expect(conditionsOf([{ ...row, type: "log", pattern: "(" }])).toBe("invalid regex: (");
  });
});
