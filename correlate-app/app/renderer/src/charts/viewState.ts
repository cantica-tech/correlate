/**
 * The live view's time axis (REQ-000031-sJpO9KMY, br-VIEW-000001-sJpO9KMY),
 * as cttc's (`app.js`: `setView` ~1924, `followNow` and `goLive` ~1980, the
 * 1 s ticker ~2010, `recenterOn` ~2064, the navigator ~2100-2180). Pure: the
 * view, whether it follows now, and when a paused view goes live again.
 */
import type { Viewport } from "../correlate/atoms.js";
import { MIN_SPAN_MS } from "../correlate/zoom.js";
import { DEFAULT_SPAN_MS } from "./strips.js";

/** While live, the view is centred this far behind now: cttc's `FOLLOW_LAG`. */
export const FOLLOW_LAG_MS = 5_000;
/** How often a live view moves, and a pause's countdown is told: cttc's 1 s ticker. */
export const TICK_MS = 1_000;

/** The view, whether it follows now, and when a pause ends (cttc's `liveResumeAt`). */
export interface ViewState {
  view: Viewport;
  live: boolean;
  /** When a paused view goes live again, or null: paused until "now". */
  resumeAt: number | null;
}

/** `view`'s span centred on now - 5 s (cttc's `followNow`). */
export function followed(view: Viewport | null, now: number): Viewport {
  const span = view ? view.t1 - view.t0 : DEFAULT_SPAN_MS;
  const centre = now - FOLLOW_LAG_MS;
  return { t0: centre - span / 2, t1: centre + span / 2 };
}

/** A live view at the default 10 min span. */
export function initialState(now: number): ViewState {
  return { view: followed(null, now), live: true, resumeAt: null };
}

/** Live again (cttc's `goLive`); `resetSpan`: back to the default span, as the navigator's "now". */
export function goLive(state: ViewState, now: number, resetSpan = false): ViewState {
  return { view: followed(resetSpan ? null : state.view, now), live: true, resumeAt: null };
}

/** The 1 s tick: a live view moves; a pause whose time has come goes live, the span kept. */
export function tick(state: ViewState, now: number): ViewState {
  if (state.live) return { ...state, view: followed(state.view, now) };
  if (state.resumeAt !== null && now >= state.resumeAt) return goLive(state, now);
  return state;
}

/**
 * A pan or zoom (cttc's `setView` from anything but the ticker): the view
 * stops following now and a pending resume is cancelled; null when the view
 * would be under 200 ms (refused, br-VIEW-000002-sJpO9KMY).
 */
export function moved(view: Viewport): ViewState | null {
  if (view.t1 - view.t0 < MIN_SPAN_MS) return null;
  return { view, live: false, resumeAt: null };
}

/**
 * A recentre on `t` (a double-click, a row's click; cttc's `recenterOn`): the
 * span kept; a live view pauses and goes live again `resumeSecs` later, or
 * stays paused when it is 0; a view already paused stays so.
 */
export function recentred(state: ViewState, t: number, now: number, resumeSecs: number): ViewState {
  const span = Math.max(MIN_SPAN_MS, state.view.t1 - state.view.t0);
  const view = { t0: t - span / 2, t1: t + span / 2 };
  const resumeAt = state.live && resumeSecs > 0 ? now + resumeSecs * 1000 : null;
  return { view, live: false, resumeAt };
}

/** The whole seconds left before a pause ends, or null when none is pending. */
export function countdown(state: ViewState, now: number): number | null {
  if (state.live || state.resumeAt === null) return null;
  return Math.max(0, Math.ceil((state.resumeAt - now) / 1000));
}

/** What the status bar says while a pause counts down (cttc's words). */
export function countdownText(seconds: number): string {
  return `Live tracking disabled — resuming in ${seconds}s (clicking "now" will resume live tracking)`;
}

/** The navigator's bounds (cttc's `totalSpanBounds`): the data, the view and now. */
export function navBounds(
  view: Viewport,
  data: { from: number; to: number } | null,
  now: number,
): { lo: number; hi: number } {
  let lo = Math.min(data?.from ?? view.t0, view.t0, now);
  const hi = Math.max(data?.to ?? view.t1, view.t1, now);
  if (!Number.isFinite(lo)) lo = view.t0;
  return { lo, hi: Math.max(hi, lo + 1) };
}

/** The thumb's left and width in a track `width` px wide, at least 8 px (cttc's). */
export function thumbOf(
  view: Viewport,
  bounds: { lo: number; hi: number },
  width: number,
): { left: number; width: number } {
  const span = bounds.hi - bounds.lo;
  const x0 = ((view.t0 - bounds.lo) / span) * width;
  const x1 = ((view.t1 - bounds.lo) / span) * width;
  return { left: Math.max(0, x0), width: Math.max(8, x1 - x0) };
}

/** The view centred on the time at `fraction` of the track, the span kept (a click on the track). */
export function viewAtTrack(
  view: Viewport,
  bounds: { lo: number; hi: number },
  fraction: number,
): Viewport {
  const t = bounds.lo + fraction * (bounds.hi - bounds.lo);
  const span = view.t1 - view.t0;
  return { t0: t - span / 2, t1: t + span / 2 };
}

/** The view shifted by a thumb drag of `dx` px in a track `width` px wide. */
export function viewDragged(
  start: Viewport,
  bounds: { lo: number; hi: number },
  dx: number,
  width: number,
): Viewport {
  const dt = (dx / Math.max(1, width)) * (bounds.hi - bounds.lo);
  return { t0: start.t0 + dt, t1: start.t1 + dt };
}

/** Live tracking's cursor (cttc's `liveTrackTick`): now + offset while live and enabled, else null. */
export function liveCursor(
  state: ViewState,
  now: number,
  settings: { liveTrack: boolean; liveTrackSecs: number },
): number | null {
  if (!state.live || !settings.liveTrack) return null;
  return now + Math.min(0, settings.liveTrackSecs) * 1000;
}

/** A file's span is never framed narrower than cttc's 1.5 s. */
export const FRAME_MIN_SPAN_MS = 1_500;

/**
 * A file's frame (REQ-000034-sJpO9KMY, br-ANLYS-000004-sJpO9KMY, cttc's
 * framing): centred on the file's midpoint, its span (1.5 s at least)
 * filling 75% of the view, a sixth of it on each side. It is also the widest
 * view the analysis view allows: its bounds (br-ANLYS-000003-sJpO9KMY).
 */
export function frameOf(range: { from: number; to: number }): { from: number; to: number } {
  const span = Math.max(range.to - range.from, FRAME_MIN_SPAN_MS);
  const middle = (range.from + range.to) / 2;
  return { from: middle - (span / 2) * (4 / 3), to: middle + (span / 2) * (4 / 3) };
}

/**
 * The analysis view (REQ-000033-sJpO9KMY, br-ANLYS-000002-sJpO9KMY): a file's
 * view is never live and opens on its frame.
 */
export function fileState(range: { from: number; to: number }): ViewState {
  const frame = frameOf(range);
  return { view: { t0: frame.from, t1: frame.to }, live: false, resumeAt: null };
}

/**
 * `view` kept within `range` (br-ANLYS-000003-sJpO9KMY): no wider than the
 * range, and shifted back inside it; the 200 ms floor still holds.
 */
export function bounded(view: Viewport, range: { from: number; to: number }): Viewport {
  const room = range.to - range.from;
  const span = Math.min(Math.max(view.t1 - view.t0, MIN_SPAN_MS), Math.max(room, MIN_SPAN_MS));
  const t0 = Math.min(Math.max(view.t0, range.from), Math.max(range.from, range.to - span));
  return { t0, t1: t0 + span };
}
