/**
 * REQ-000031-sJpO9KMY, br-VIEW-000001-sJpO9KMY and br-VIEW-000002-sJpO9KMY:
 * the live view's time axis, as cttc's.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SPAN_MS } from "../strips.js";
import {
  bounded,
  countdown,
  countdownText,
  FOLLOW_LAG_MS,
  fileState,
  followed,
  goLive,
  initialState,
  liveCursor,
  moved,
  navBounds,
  recentred,
  thumbOf,
  tick,
  viewAtTrack,
  viewDragged,
} from "../viewState.js";

const NOW = 1_000_000_000;

describe("br-VIEW-000001-sJpO9KMY: live follow", () => {
  it("centres the view 5 s behind now, at 10 min to begin with, its span kept", () => {
    const start = initialState(NOW);
    expect(start.live).toBe(true);
    expect(start.view).toEqual({
      t0: NOW - FOLLOW_LAG_MS - DEFAULT_SPAN_MS / 2,
      t1: NOW - FOLLOW_LAG_MS + DEFAULT_SPAN_MS / 2,
    });
    expect(followed({ t0: 0, t1: 2000 }, NOW)).toEqual({ t0: NOW - 6000, t1: NOW - 4000 });
  });

  it("moves with every tick while live; a paused view stays put", () => {
    const later = tick(initialState(NOW), NOW + 1000);
    expect(later.view.t1 - initialState(NOW).view.t1).toBe(1000);
    const paused = { view: { t0: 0, t1: 1000 }, live: false, resumeAt: null };
    expect(tick(paused, NOW)).toBe(paused);
  });
});

describe("br-VIEW-000001-sJpO9KMY: pause and resume", () => {
  it("pauses a live view on a recentre and resumes after the delay, span kept", () => {
    const live = { view: { t0: NOW - 2000, t1: NOW }, live: true, resumeAt: null };
    const paused = recentred(live, NOW - 10_000, NOW, 10);
    expect(paused).toEqual({
      view: { t0: NOW - 11_000, t1: NOW - 9_000 },
      live: false,
      resumeAt: NOW + 10_000,
    });
    expect(countdown(paused, NOW + 2_500)).toBe(8);
    expect(countdownText(8)).toBe(
      'Live tracking disabled — resuming in 8s (clicking "now" will resume live tracking)',
    );
    expect(tick(paused, NOW + 9_999)).toBe(paused);
    const back = tick(paused, NOW + 10_000);
    expect(back.live).toBe(true);
    expect(back.view.t1 - back.view.t0).toBe(2000);
    expect(countdown(back, NOW)).toBeNull();
  });

  it("stays paused with a 0 s delay, or when it was not live", () => {
    const live = { view: { t0: 0, t1: 1000 }, live: true, resumeAt: null };
    expect(recentred(live, 5000, NOW, 0).resumeAt).toBeNull();
    const still = { view: { t0: 0, t1: 1000 }, live: false, resumeAt: null };
    expect(recentred(still, 5000, NOW, 10).resumeAt).toBeNull();
  });

  it("stops following, and cancels a pending resume, on a pan or zoom", () => {
    expect(moved({ t0: 100, t1: 600 })).toEqual({
      view: { t0: 100, t1: 600 },
      live: false,
      resumeAt: null,
    });
    expect(moved({ t0: 0, t1: 199 })).toBeNull();
  });

  it("goes live at the default span from the navigator's now", () => {
    const zoomed = { view: { t0: 0, t1: 1000 }, live: false, resumeAt: null };
    expect(goLive(zoomed, NOW, true).view).toEqual(initialState(NOW).view);
    expect(goLive(zoomed, NOW).view.t1 - goLive(zoomed, NOW).view.t0).toBe(1000);
  });
});

describe("br-VIEW-000001-sJpO9KMY: live tracking", () => {
  it("puts the cursor at now + offset while live and enabled, never ahead of now", () => {
    const live = initialState(NOW);
    expect(liveCursor(live, NOW, { liveTrack: true, liveTrackSecs: -3 })).toBe(NOW - 3000);
    expect(liveCursor(live, NOW, { liveTrack: true, liveTrackSecs: 4 })).toBe(NOW);
    expect(liveCursor(live, NOW, { liveTrack: false, liveTrackSecs: 0 })).toBeNull();
    expect(
      liveCursor({ ...live, live: false }, NOW, { liveTrack: true, liveTrackSecs: 0 }),
    ).toBeNull();
  });
});

describe("REQ-000031-sJpO9KMY: the navigator", () => {
  it("spans the data, the view and now", () => {
    expect(navBounds({ t0: 50, t1: 60 }, { from: 0, to: 100 }, 80)).toEqual({ lo: 0, hi: 100 });
    expect(navBounds({ t0: 50, t1: 60 }, null, 200)).toEqual({ lo: 50, hi: 200 });
  });

  it("draws the thumb, at least 8 px, and pans by it or the track", () => {
    const bounds = { lo: 0, hi: 1000 };
    expect(thumbOf({ t0: 250, t1: 500 }, bounds, 400)).toEqual({ left: 100, width: 100 });
    expect(thumbOf({ t0: 250, t1: 251 }, bounds, 400).width).toBe(8);
    expect(viewAtTrack({ t0: 0, t1: 100 }, bounds, 0.5)).toEqual({ t0: 450, t1: 550 });
    expect(viewDragged({ t0: 0, t1: 100 }, bounds, 40, 400)).toEqual({ t0: 100, t1: 200 });
  });
});

describe("br-ANLYS-000003-sJpO9KMY: the analysis view stays within its file", () => {
  const file = { from: 10_000, to: 70_000 };

  it("opens on the file's range, never live", () => {
    expect(fileState(file)).toEqual({
      view: { t0: 10_000, t1: 70_000 },
      live: false,
      resumeAt: null,
    });
  });

  it("keeps pans and zooms inside the file, no wider than it, 200 ms at least", () => {
    expect(bounded({ t0: 0, t1: 5_000 }, file)).toEqual({ t0: 10_000, t1: 15_000 });
    expect(bounded({ t0: 68_000, t1: 78_000 }, file)).toEqual({ t0: 60_000, t1: 70_000 });
    expect(bounded({ t0: 0, t1: 1_000_000 }, file)).toEqual({ t0: 10_000, t1: 70_000 });
    expect(bounded({ t0: 20_000, t1: 20_050 }, file)).toEqual({ t0: 20_000, t1: 20_200 });
  });
});
