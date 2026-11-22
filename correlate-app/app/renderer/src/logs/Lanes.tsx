/**
 * The event-density lanes (REQ-000029-sJpO9KMY Requirement 3), in cttc's
 * markup (`index.html:247-251`, `drawLane` at `app.js:905-929`): the "Log
 * entries" head and its toggle, folded by default and remembered; one 8 px
 * lane per container, in the legend's order and color, a tick per bucket
 * with log rows, stronger where there are more, on the charts' time axis.
 * The cursor is drawn across them, and a click sets it (REQ-000030-sJpO9KMY);
 * the now line and live tracking's cursor too, a double-click recentres and a
 * drag zooms, as on the strips (REQ-000031-sJpO9KMY).
 */
import { useEffect, useRef, useState } from "react";
import { timeAt, xAt } from "../charts/ChartBlock.js";
import { drawCursorMark, drawNowMark } from "../charts/marks.js";
import type { Viewport } from "../correlate/atoms.js";
import { PLOT_MARGIN_LEFT } from "../correlate/axes.js";
import { drawBands } from "../correlate/chartDraw.js";
import { colorForSlot, resolveColor, type SlotMap } from "../correlate/colorSlots.js";
import { isClick } from "../correlate/zoom.js";
import { RECORDING_BAND_COLOR } from "../recording/bands.js";
import type { SumpRequester } from "../shell/bridge.js";
import { density } from "./api.js";

/** A lane's height: cttc's `LANE_H`. */
export const LANE_HEIGHT = 8;

/** Where and how strong one tick is. */
export interface Tick {
  x: number;
  width: number;
  alpha: number;
}

/**
 * cttc's ticks for `counts`, buckets over `asked`, drawn on a canvas `width`
 * px wide showing `shown` (a live view moves between reads): one per bucket
 * with rows, its alpha 0.35 + 0.65 of its share of the busiest bucket.
 */
export function laneTicks(
  counts: readonly number[],
  asked: Viewport,
  shown: Viewport,
  width: number,
): Tick[] {
  const n = counts.length;
  if (n === 0) return [];
  const max = Math.max(1, ...counts);
  const bucket = (asked.t1 - asked.t0) / n;
  const plot = Math.max(1, width - PLOT_MARGIN_LEFT);
  const ticks: Tick[] = [];
  counts.forEach((count, b) => {
    if (!count) return;
    ticks.push({
      x: xAt(asked.t0 + b * bucket, shown, width),
      width: Math.max(1, (bucket / (shown.t1 - shown.t0)) * plot - 0.5),
      alpha: 0.35 + 0.65 * (count / max),
    });
  });
  return ticks;
}

/** The lanes' props. */
export interface LanesProps {
  request: SumpRequester;
  /** The active stream's id. */
  stream: string;
  /** The containers shown, in the legend's order. */
  containers: readonly string[];
  slots: SlotMap;
  view: Viewport;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** The time range drawn, which a live view moves every second. */
  shownView?: Viewport;
  /** Now, for the now line. */
  nowT?: number | null;
  /** The window's cursor, or null. */
  cursorT?: number | null;
  /** Live tracking put the cursor there. */
  cursorLive?: boolean;
  /** A click on a lane sets the cursor. */
  onCursor?: (t: number) => void;
  /** A double-click recentres there. */
  onRecenter?: (t: number) => void;
  /** A drag zooms to its range. */
  onZoom?: (ta: number, tb: number) => void;
  /** Capture mode is armed: a drag captures instead of zooming (REQ-000041-sJpO9KMY). */
  captureArmed?: boolean;
  /** A Shift, Ctrl or Cmd drag, or any drag while armed: capture the range. */
  onCapture?: (ta: number, tb: number) => void;
  /** A right-click at time `t`: cttc's time menu. */
  onTimeMenu?: (x: number, y: number, t: number) => void;
  /** What the recording has captured, banded behind the ticks (REQ-000040-sJpO9KMY). */
  bands?: readonly { t0: number; t1: number }[];
}

/** No recording band. */
const NO_BANDS: readonly { t0: number; t1: number }[] = [];

/** The lanes. */
export function Lanes({
  request,
  stream,
  containers,
  slots,
  view,
  open,
  onToggle,
  shownView,
  nowT = null,
  cursorT = null,
  cursorLive = false,
  onCursor,
  onRecenter,
  onZoom,
  bands = NO_BANDS,
  captureArmed = false,
  onCapture,
  onTimeMenu,
}: LanesProps) {
  const drawn = shownView ?? view;
  const downX = useRef<number | null>(null);
  const [counts, setCounts] = useState<Record<string, number[]>>({});
  const [width, setWidth] = useState(0);
  const lanesRef = useRef<HTMLDivElement>(null);
  const canvases = useRef<Record<string, HTMLCanvasElement | null>>({});

  useEffect(() => {
    const el = lanesRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Folded, nothing is read.
  useEffect(() => {
    if (!open || containers.length === 0) return;
    let live = true;
    const plot = Math.max(1, (lanesRef.current?.clientWidth || 600) - PLOT_MARGIN_LEFT);
    void Promise.all(
      containers.map(
        async (name) => [name, await density(request, `${stream}/${name}`, view, plot)] as const,
      ),
    ).then((pairs) => {
      if (!live) return;
      setCounts(Object.fromEntries(pairs.filter((p): p is [string, number[]] => p[1] !== null)));
    });
    return () => {
      live = false;
    };
  }, [request, stream, containers, view, open]);

  useEffect(() => {
    if (!open || !width) return;
    const style = getComputedStyle(document.documentElement);
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const ratio = window.devicePixelRatio || 1;
    for (const name of containers) {
      const canvas = canvases.current[name];
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) continue;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(LANE_HEIGHT * ratio);
      canvas.style.height = `${LANE_HEIGHT}px`;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, LANE_HEIGHT);
      // cttc's drawHighlightBands: the recording's band first, behind; no sprocket holes on lanes.
      if (bands.length > 0) {
        const area = { left: PLOT_MARGIN_LEFT, width: Math.max(1, width - PLOT_MARGIN_LEFT) };
        drawBands(ctx, bands, drawn, { ...area, height: LANE_HEIGHT }, RECORDING_BAND_COLOR);
      }
      ctx.fillStyle = resolveColor(colorForSlot(slots[name] ?? 0, dark), (v) =>
        style.getPropertyValue(v).trim(),
      );
      for (const tick of laneTicks(counts[name] ?? [], view, drawn, width)) {
        ctx.globalAlpha = tick.alpha;
        ctx.fillRect(tick.x, 1, tick.width, LANE_HEIGHT - 2);
      }
      ctx.globalAlpha = 1;
      // cttc's drawVerticals: the cursor, then the now line.
      const inView = (t: number) => t >= drawn.t0 && t <= drawn.t1;
      if (cursorT !== null && inView(cursorT)) {
        const accent = style.getPropertyValue("--accent").trim();
        drawCursorMark(ctx, xAt(cursorT, drawn, width), LANE_HEIGHT, cursorLive, accent);
      }
      if (nowT !== null && inView(nowT)) drawNowMark(ctx, xAt(nowT, drawn, width), LANE_HEIGHT);
    }
  }, [open, width, counts, containers, slots, cursorT, cursorLive, nowT, view, drawn, bands]);

  return (
    <>
      <div id="lanes-head">
        <span>Log entries</span>
        <button
          type="button"
          id="btn-lanes-toggle"
          className="icon-btn"
          title={open ? "Hide log entry markers" : "Show log entry markers"}
          aria-expanded={open}
          onClick={() => onToggle(!open)}
        >
          {open ? "▾" : "▸"}
        </button>
      </div>
      <div id="lanes" ref={lanesRef} hidden={!open}>
        {containers.map((name) => (
          <canvas
            key={name}
            className="lane-canvas"
            title={name}
            role="img"
            aria-label={`Log entries of ${name}`}
            ref={(el) => {
              canvases.current[name] = el;
            }}
            onMouseDown={(e) => {
              downX.current = e.nativeEvent.offsetX;
            }}
            onMouseUp={(e) => {
              const x = e.nativeEvent.offsetX;
              const from = downX.current;
              downX.current = null;
              if (from === null) return;
              const w = e.currentTarget.clientWidth;
              if (!isClick(from, x)) {
                const ta = timeAt(Math.max(PLOT_MARGIN_LEFT, from), drawn, w);
                const tb = timeAt(Math.max(PLOT_MARGIN_LEFT, x), drawn, w);
                if (ta === null || tb === null) return;
                const capturing = e.shiftKey || e.ctrlKey || e.metaKey || captureArmed;
                if (capturing && onCapture) onCapture(ta, tb);
                else onZoom?.(ta, tb);
                return;
              }
              const t = timeAt(x, drawn, w);
              if (t !== null) onCursor?.(t);
            }}
            onContextMenu={(e) => {
              const t = timeAt(e.nativeEvent.offsetX, drawn, e.currentTarget.clientWidth);
              if (t === null || !onTimeMenu) return;
              e.preventDefault();
              onTimeMenu(e.clientX, e.clientY, t);
            }}
            onDoubleClick={(e) => {
              const t = timeAt(e.nativeEvent.offsetX, drawn, e.currentTarget.clientWidth);
              if (t !== null) onRecenter?.(t);
            }}
          />
        ))}
      </div>
    </>
  );
}
