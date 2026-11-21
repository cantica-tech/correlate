/**
 * The event-density lanes (REQ-000029-sJpO9KMY Requirement 3), in cttc's
 * markup (`index.html:247-251`, `drawLane` at `app.js:905-929`): the "Log
 * entries" head and its toggle, folded by default and remembered; one 8 px
 * lane per container, in the legend's order and color, a tick per bucket
 * with log rows, stronger where there are more, on the charts' time axis.
 */
import { useEffect, useRef, useState } from "react";
import type { Viewport } from "../correlate/atoms.js";
import { PLOT_MARGIN_LEFT } from "../correlate/axes.js";
import { colorForSlot, resolveColor, type SlotMap } from "../correlate/colorSlots.js";
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
 * cttc's ticks for `counts` over a plot `plotWidth` wide starting at
 * `marginLeft`: one per bucket with rows, its alpha 0.35 + 0.65 of its share
 * of the busiest bucket.
 */
export function laneTicks(
  counts: readonly number[],
  plotWidth: number,
  marginLeft: number,
): Tick[] {
  const n = counts.length;
  if (n === 0) return [];
  const max = Math.max(1, ...counts);
  const ticks: Tick[] = [];
  counts.forEach((count, b) => {
    if (!count) return;
    ticks.push({
      x: marginLeft + (b / n) * plotWidth,
      width: Math.max(1, plotWidth / n - 0.5),
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
}

/** The lanes. */
export function Lanes({ request, stream, containers, slots, view, open, onToggle }: LanesProps) {
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
      ctx.fillStyle = resolveColor(colorForSlot(slots[name] ?? 0, dark), (v) =>
        style.getPropertyValue(v).trim(),
      );
      for (const tick of laneTicks(
        counts[name] ?? [],
        width - PLOT_MARGIN_LEFT,
        PLOT_MARGIN_LEFT,
      )) {
        ctx.globalAlpha = tick.alpha;
        ctx.fillRect(tick.x, 1, tick.width, LANE_HEIGHT - 2);
      }
      ctx.globalAlpha = 1;
    }
  }, [open, width, counts, containers, slots]);

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
          />
        ))}
      </div>
    </>
  );
}
