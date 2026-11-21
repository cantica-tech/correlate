import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LIVE_CHANGED_EVENT,
  LIVE_DEFAULTS,
  LIVE_GET_CHANNEL,
  LIVE_SET_CHANNEL,
  liveSettings,
  registerLiveIpc,
  setLiveSettings,
} from "../live.js";
import { Settings } from "../theme.js";

// REQ-000031-sJpO9KMY Requirement 4, br-VIEW-000002-sJpO9KMY: the live settings and their limits.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "live-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const quiet = { warn: () => {} };
const settings = () => new Settings(path.join(dir, "settings.json"), quiet);

describe("REQ-000031-sJpO9KMY: the live settings", () => {
  it("are cttc's defaults until changed, then kept across restarts", () => {
    expect(liveSettings(settings())).toEqual({
      windowSecs: 5,
      liveTrack: true,
      liveTrackSecs: 0,
      resumeSecs: 10,
    });
    setLiveSettings(settings(), { windowSecs: 3, liveTrack: false });
    expect(liveSettings(settings())).toEqual({ ...LIVE_DEFAULTS, windowSecs: 3, liveTrack: false });
  });

  it("clamp to br-VIEW-000002's limits, as cttc's inputs did", () => {
    expect(setLiveSettings(settings(), { windowSecs: 0.2 }).windowSecs).toBe(1);
    expect(setLiveSettings(settings(), { liveTrackSecs: 7 }).liveTrackSecs).toBe(0);
    expect(setLiveSettings(settings(), { liveTrackSecs: -2.4 }).liveTrackSecs).toBe(-2);
    expect(setLiveSettings(settings(), { resumeSecs: -5 }).resumeSecs).toBe(0);
  });

  it.each([[{ windowSecs: "5" }], [{ liveTrack: 1 }], [{ pollSecs: 2 }], [null], [[1]]])(
    "refuse %j",
    (change) => {
      expect(() => setLiveSettings(settings(), change)).toThrow();
    },
  );

  it("answer their channels and tell every window of a change", async () => {
    const handlers = new Map<string, (e: object, m: unknown) => unknown>();
    const told: unknown[] = [];
    registerLiveIpc({ handle: (c, l) => void handlers.set(c, l) }, settings(), (channel, value) =>
      told.push([channel, value]),
    );
    expect(await handlers.get(LIVE_GET_CHANNEL)?.({}, undefined)).toEqual(LIVE_DEFAULTS);
    expect(await handlers.get(LIVE_SET_CHANNEL)?.({}, { resumeSecs: 0 })).toMatchObject({
      ok: true,
    });
    expect(told).toEqual([[LIVE_CHANGED_EVENT, { ...LIVE_DEFAULTS, resumeSecs: 0 }]]);
    expect(await handlers.get(LIVE_SET_CHANNEL)?.({}, { resumeSecs: "x" })).toMatchObject({
      ok: false,
    });
  });
});
