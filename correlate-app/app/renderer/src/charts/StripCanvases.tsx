/**
 * One group of cttc's strips (`canvas.strip`: CPU %, MEM %, NET), sharing
 * their box's height as cttc's `computeStripH`, drawn with the ported
 * `drawChartStrip` and cttc's marks (REQ-000028-sJpO9KMY,
 * REQ-000031-sJpO9KMY). The container charts (`#charts`) and the host's
 * (`#host-charts`, REQ-000032-sJpO9KMY) are two of these, each with its own
 * lines and never the other's.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Viewport } from "../correlate/atoms.js";
import { PLOT_MARGIN_LEFT, TIME_AXIS_HEIGHT } from "../correlate/axes.js";
import { type ChartSeries, drawChartStrip } from "../correlate/chartDraw.js";
import { colorForSlot, resolveColor } from "../correlate/colorSlots.js";
import { tToX, xToT } from "../correlate/timeMapping.js";
import { isClick } from "../correlate/zoom.js";
import { useAppearance } from "../theme/appearance.js";
import { drawCursorMark, drawNowMark } from "./marks.js";
import { STRIPS } from "./strips.js";

/** No recording band. */
const NO_BANDS: readonly { t0: number; t1: number }[] = [];

/** A strip is never shorter than cttc's 44 px. */
const STRIP_MIN_H = 44;

/** Per strip, per line, its points. */
export type StripData = Record<string, Record<string, ChartSeries["points"]>>;

/** One line: its name in the data, and its color slot. */
export interface StripLine {
  name: string;
  slot: number;
}

/** The cursor, and whether live tracking put it there. */
export interface Cursor {
  t: number;
  live: boolean;
}

/**
 * A percentage strip runs from 0 to 100, or higher when the data does: Docker
 * gives CPU above 100% on a machine with several cores (101.5% was seen).
 */
export function percentCeiling(series: readonly ChartSeries[]): number {
  const top = Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.v)));
  return top > 100 ? Math.ceil(top / 10) * 10 : 100;
}

/** The time at `x` px of a canvas `width` px wide, or null left of the plot. */
export function timeAt(x: number, view: Viewport, width: number): number | null {
  if (x < PLOT_MARGIN_LEFT) return null;
  return xToT(x - PLOT_MARGIN_LEFT, view, Math.max(1, width - PLOT_MARGIN_LEFT));
}

/** Where `t` is drawn on a canvas `width` px wide. */
export function xAt(t: number, view: Viewport, width: number): number {
  return PLOT_MARGIN_LEFT + tToX(t, view, Math.max(1, width - PLOT_MARGIN_LEFT));
}

/** The strips' props. */
export interface StripCanvasesProps {
  /** `charts` or `host-charts`. */
  id: string;
  lines: readonly StripLine[];
  data: StripData;
  view: Viewport;
  /** The view at the moment of a click (it may have moved since the last render). */
  currentView: () => Viewport;
  cursor: Cursor | null;
  nowT: number;
  /** What the recording has captured (REQ-000040-sJpO9KMY). */
  bands?: readonly { t0: number; t1: number }[];
  /** The strips are not drawn (nothing to show); `children` say why. */
  empty?: boolean;
  hidden?: boolean;
  /** What the strips are of, for screen readers. */
  label: string;
  onCursor: (t: number) => void;
  onZoom: (ta: number, tb: number) => void;
  onRecenter: (t: number) => void;
  /** Capture mode is armed: a drag captures instead of zooming (REQ-000041-sJpO9KMY). */
  captureArmed?: boolean;
  /** A Shift, Ctrl or Cmd drag, or any drag while armed: capture the range (br-EXPORT-000003-sJpO9KMY). */
  onCapture?: (ta: number, tb: number) => void;
  /** A right-click at time `t`: cttc's time menu. */
  onTimeMenu?: (x: number, y: number, t: number) => void;
  children?: ReactNode;
}

/** A group of strips. */
export function StripCanvases(props: StripCanvasesProps) {
  const { id, lines, data, view, cursor, nowT, empty = false, hidden = false } = props;
  const bands = props.bands ?? NO_BANDS;
  // The Appearance pane's colors: the strips redraw when they change (REQ-000050).
  const look = useAppearance();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const downX = useRef<number | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      setSize({ width: el.clientWidth, height: el.clientHeight }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!size.width || hidden) return;
    const style = getComputedStyle(document.documentElement);
    const readVar = (name: string) => style.getPropertyValue(name).trim();
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const stripH = Math.max(
      STRIP_MIN_H,
      Math.floor((size.height - TIME_AXIS_HEIGHT) / STRIPS.length),
    );
    const ratio = window.devicePixelRatio || 1;
    const inView = (t: number) => t >= view.t0 && t <= view.t1;
    STRIPS.forEach((strip, i) => {
      const canvas = canvases.current[i];
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const last = i === STRIPS.length - 1;
      const height = stripH + (last ? TIME_AXIS_HEIGHT : 0);
      canvas.width = Math.round(size.width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.height = `${height}px`;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.font = "10px system-ui, sans-serif";
      const series = lines.map((line) => ({
        points: data[strip.key]?.[line.name] ?? [],
        color: resolveColor(colorForSlot(line.slot, dark), readVar),
      }));
      drawChartStrip(ctx, {
        view,
        series,
        // The film strip bookends the group: holes on top of the first, below the last.
        bands,
        bandColor: look.recordingColor,
        sprockets: look.sprockets ? { top: i === 0, bottom: last } : undefined,
        cursorT: null,
        plotWidth: size.width,
        height,
        marginLeft: PLOT_MARGIN_LEFT,
        axisHeight: last ? TIME_AXIS_HEIGHT : 0,
        unit: strip.unit,
        gridColor: readVar("--border"),
        labelColor: readVar("--muted"),
        minValue: 0,
        maxValue: strip.percent ? percentCeiling(series) : undefined,
      });
      // cttc's drawVerticals: the cursor, then the now line, over the plot.
      const plotH = height - (last ? TIME_AXIS_HEIGHT : 0);
      if (cursor && inView(cursor.t)) {
        const x = xAt(cursor.t, view, size.width);
        drawCursorMark(ctx, x, plotH, cursor.live, readVar("--accent"));
      }
      if (inView(nowT)) drawNowMark(ctx, xAt(nowT, view, size.width), plotH);
      // The strip's title at its top left, as cttc's strips.
      ctx.fillStyle = readVar("--text-secondary");
      ctx.font = "600 10px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(strip.title, PLOT_MARGIN_LEFT + 6, 4);
    });
  }, [size, data, lines, view, cursor, nowT, hidden, bands, look]);

  return (
    <div id={id} ref={boxRef} hidden={hidden}>
      {props.children}
      {STRIPS.map((strip, i) => (
        <canvas
          key={strip.key}
          className="strip"
          data-strip={i}
          hidden={empty}
          role="img"
          aria-label={`${strip.title}: ${props.label}`}
          ref={(el) => {
            canvases.current[i] = el;
          }}
          onMouseDown={(e) => {
            downX.current = e.nativeEvent.offsetX;
          }}
          onMouseUp={(e) => {
            const x = e.nativeEvent.offsetX;
            const from = downX.current;
            downX.current = null;
            if (from === null) return;
            const width = e.currentTarget.clientWidth;
            const current = props.currentView();
            // cttc's timelineUp: a drag zooms to its range (or captures it), a click sets the cursor.
            if (!isClick(from, x)) {
              const ta = timeAt(Math.max(PLOT_MARGIN_LEFT, from), current, width);
              const tb = timeAt(Math.max(PLOT_MARGIN_LEFT, x), current, width);
              if (ta === null || tb === null) return;
              const capturing = e.shiftKey || e.ctrlKey || e.metaKey || props.captureArmed;
              if (capturing && props.onCapture) props.onCapture(ta, tb);
              else props.onZoom(ta, tb);
              return;
            }
            const t = timeAt(x, current, width);
            if (t !== null) props.onCursor(t);
          }}
          onContextMenu={(e) => {
            const t = timeAt(
              e.nativeEvent.offsetX,
              props.currentView(),
              e.currentTarget.clientWidth,
            );
            if (t === null || !props.onTimeMenu) return;
            e.preventDefault();
            props.onTimeMenu(e.clientX, e.clientY, t);
          }}
          onDoubleClick={(e) => {
            const width = e.currentTarget.clientWidth;
            const t = timeAt(e.nativeEvent.offsetX, props.currentView(), width);
            if (t !== null) props.onRecenter(t);
          }}
        />
      ))}
    </div>
  );
}
