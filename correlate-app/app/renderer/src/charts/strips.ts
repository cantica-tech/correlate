/**
 * The charts' strips (REQ-000028-sJpO9KMY Requirement 2): cttc's CPU %, MEM %
 * and NET (`app.js:207-211`), each read from the Sump's buckets route
 * (`GET /records/buckets`): a field or fields, as a percentage of another, or
 * a counter's rate. Pure: what to ask, and the points the answer makes.
 */

import type { Viewport } from "../correlate/atoms.js";
import type { ChartPoint } from "../correlate/chartDraw.js";

/** One strip. */
export interface Strip {
  key: "cpu" | "mem" | "net";
  title: string;
  /** The record fields, summed. */
  fields: string[];
  /** A percentage of this field. */
  over?: string;
  mode: "max" | "rate";
  /** The value axis's unit. */
  unit: string;
  /** Values are divided by this before drawing (NET in kB/s, as cttc). */
  scale: number;
  /** A percentage strip is drawn from 0 to 100. */
  percent: boolean;
}

/** cttc's three strips, decided in FEAT-000029-sJpO9KMY. */
export const STRIPS: readonly Strip[] = [
  {
    key: "cpu",
    title: "CPU %",
    fields: ["cpu_percent"],
    mode: "max",
    unit: "%",
    scale: 1,
    percent: true,
  },
  {
    key: "mem",
    title: "MEM %",
    fields: ["mem_used_bytes"],
    over: "mem_limit_bytes",
    mode: "max",
    unit: "%",
    scale: 1,
    percent: true,
  },
  {
    key: "net",
    title: "NET",
    fields: ["net_rx_bytes", "net_tx_bytes"],
    mode: "rate",
    unit: " kB/s",
    scale: 1000,
    percent: false,
  },
];

/** The chart's time range: the last 10 minutes (Item 32 brings zoom and pan). */
export const DEFAULT_SPAN_MS = 10 * 60 * 1000;
/** A view is never narrower than this (br-VIEW-000002-sJpO9KMY). */
export const MIN_SPAN_MS = 200;

/** A view ending at `now`, `spanMs` wide but never under 200 ms. */
export function viewEndingAt(now: number, spanMs = DEFAULT_SPAN_MS): Viewport {
  const span = Math.max(MIN_SPAN_MS, spanMs);
  return { t0: now - span, t1: now };
}

/** The buckets route's query for one strip, one source, over `view`. */
export function bucketsQuery(strip: Strip, source: string, view: Viewport, buckets: number) {
  const query: Record<string, string | number> = {
    source,
    from: new Date(view.t0).toISOString(),
    to: new Date(view.t1).toISOString(),
    buckets: Math.max(1, Math.min(2000, Math.floor(buckets))),
    mode: strip.mode,
  };
  if (strip.over) query.over = strip.over;
  // The bridge sends one value per key: the fields comma-separated.
  query.field = strip.fields.join(",");
  return query;
}

/** The buckets' values as points, each at its bucket's middle; empty buckets left out. */
export function bucketsToPoints(
  values: readonly (number | null)[],
  view: Viewport,
  scale = 1,
): ChartPoint[] {
  const width = (view.t1 - view.t0) / Math.max(1, values.length);
  const points: ChartPoint[] = [];
  values.forEach((v, i) => {
    if (v !== null && Number.isFinite(v))
      points.push({ t: view.t0 + (i + 0.5) * width, v: v / scale });
  });
  return points;
}
