import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Lifecycle } from "../catalog/lifecycle.js";
import {
  HISTORY_MAX,
  type NoticeEvent,
  Notifications,
  notifyLifecycle,
  registerStatusIpc,
  STATUS_ADD_CHANNEL,
  STATUS_CLEAR_CHANNEL,
  STATUS_HISTORY_CHANNEL,
  STATUS_NOTICE_EVENT,
  STATUS_SET_VISIBLE_CHANNEL,
  STATUS_VISIBILITY_EVENT,
  STATUS_VISIBLE_CHANNEL,
  statusBarVisible,
} from "../notify.js";
import { Settings } from "../theme.js";

// REQ-000022-sJpO9KMY Requirements 2 and 4: the feed, the lifecycle's
// notifications, and the bar's visibility.

const quiet = { info: () => {}, warn: () => {} };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "notify-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("REQ-000022-sJpO9KMY: the feed", () => {
  it("keeps each message with its time, oldest first, and tells every listener", () => {
    const at = new Date("2026-11-21T17:00:00Z");
    const feed = new Notifications(quiet, () => at);
    const heard: NoticeEvent[] = [];
    feed.subscribe((e) => heard.push(e));
    feed.add("one");
    feed.add("two");
    expect(feed.list()).toEqual([
      { at: at.toISOString(), text: "one" },
      { at: at.toISOString(), text: "two" },
    ]);
    feed.clear();
    expect(feed.list()).toEqual([]);
    expect(heard.map((e) => e.type)).toEqual(["entry", "entry", "cleared"]);
  });

  it(`keeps the newest ${HISTORY_MAX}`, () => {
    const feed = new Notifications(quiet);
    for (let i = 0; i < HISTORY_MAX + 3; i += 1) feed.add(`m${i}`);
    const list = feed.list();
    expect(list).toHaveLength(HISTORY_MAX);
    expect(list[0]?.text).toBe("m3");
    expect(list.at(-1)?.text).toBe(`m${HISTORY_MAX + 2}`);
  });

  it.each([[""], ["   "], [42], ["x".repeat(501)]])("refuses %j", (text) => {
    expect(() => new Notifications(quiet).add(text)).toThrow();
  });
});

describe("REQ-000022-sJpO9KMY: lifecycle notifications", () => {
  function setup(inUse: Set<string>) {
    const lifecycle = new Lifecycle(undefined, undefined, quiet);
    lifecycle.reachable("a", "start");
    lifecycle.reachable("b", "start");
    const feed = new Notifications(quiet);
    notifyLifecycle(
      lifecycle,
      feed,
      (id) => inUse.has(id),
      (id) => id.toUpperCase(),
    );
    return { lifecycle, feed };
  }

  it("says a Sump in use is lost, once, and restored when it answers again", () => {
    const { lifecycle, feed } = setup(new Set(["a"]));
    lifecycle.unreachable("a", "no /health: timed out");
    lifecycle.unreachable("a", "no /health: timed out");
    lifecycle.reachable("a", "answered /health");
    lifecycle.reachable("a", "answered /health");
    expect(feed.list().map((n) => n.text)).toEqual([
      "Sump A connection lost: no /health: timed out",
      "Sump A connection restored",
    ]);
  });

  it("says nothing of a Sump no window is on, nor of one that only starts answering", () => {
    const { lifecycle, feed } = setup(new Set(["a"]));
    lifecycle.unreachable("b", "gone");
    lifecycle.reachable("b", "back");
    lifecycle.unreachable("c", "seeded");
    lifecycle.reachable("c", "first answer");
    expect(feed.list()).toEqual([]);
  });
});

describe("REQ-000022-sJpO9KMY: the bridge and the bar's visibility", () => {
  it("answers history, add, clear and visibility, and sends notices and visibility to every window", async () => {
    const handlers = new Map<string, (event: unknown, message: unknown) => unknown>();
    const sent: [string, unknown][] = [];
    const settings = new Settings(path.join(dir, "settings.json"), quiet);
    const feed = new Notifications(quiet);
    registerStatusIpc(
      { handle: (c, f) => void handlers.set(c, f as never) },
      feed,
      settings,
      (channel, value) => sent.push([channel, value]),
    );
    const call = (c: string, m?: unknown) =>
      (handlers.get(c) as (e: unknown, m: unknown) => unknown)({}, m);
    expect(await call(STATUS_VISIBLE_CHANNEL)).toBe(true);
    expect(await call(STATUS_ADD_CHANNEL, "Switched to Sump A")).toMatchObject({ ok: true });
    expect(await call(STATUS_ADD_CHANNEL, "<b>x</b>".repeat(100))).toMatchObject({ ok: false });
    expect(await call(STATUS_HISTORY_CHANNEL)).toMatchObject([{ text: "Switched to Sump A" }]);
    expect(await call(STATUS_CLEAR_CHANNEL)).toEqual({ ok: true });
    expect(await call(STATUS_SET_VISIBLE_CHANNEL, "no")).toMatchObject({ ok: false });
    expect(await call(STATUS_SET_VISIBLE_CHANNEL, false)).toEqual({ ok: true, visible: false });
    expect(statusBarVisible(new Settings(path.join(dir, "settings.json"), quiet))).toBe(false);
    expect(sent.map(([c, v]) => [c, (v as { type?: string }).type ?? v])).toEqual([
      [STATUS_NOTICE_EVENT, "entry"],
      [STATUS_NOTICE_EVENT, "cleared"],
      [STATUS_VISIBILITY_EVENT, false],
    ]);
  });
});
