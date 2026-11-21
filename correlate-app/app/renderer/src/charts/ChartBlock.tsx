/**
 * The telemetry charts (REQ-000028-sJpO9KMY Requirement 2), in cttc's markup
 * (`index.html:214-227`, `#chart-block`, `#legend`, `#charts` of
 * `canvas.strip`): CPU %, MEM % and NET on one timeline for the window's
 * active data stream (br-STREAM-000001-sJpO9KMY), one line per followed
 * container in a stable color, a legend that hides or shows a container in
 * every strip. The data comes from the Sump's buckets route, at most a plot's
 * width of maxima per series, read again every 5 s; drawing is the ported
 * `drawChartStrip`.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Viewport } from "../correlate/atoms.js";
import { PLOT_MARGIN_LEFT, TIME_AXIS_HEIGHT } from "../correlate/axes.js";
import { type ChartSeries, drawChartStrip } from "../correlate/chartDraw.js";
import { assignSlots, colorForSlot, resolveColor, type SlotMap } from "../correlate/colorSlots.js";
import type { ShellBridge } from "../shell/bridge.js";
import { listStreams, type Stream } from "../streams/api.js";
import { bucketsQuery, bucketsToPoints, STRIPS, viewEndingAt } from "./strips.js";

/** How often the charts are read again: cttc's poll, 5 s. */
export const CHARTS_EVERY_MS = 5_000;
/** A strip is never shorter than cttc's 44 px. */
const STRIP_MIN_H = 44;

/**
 * A percentage strip runs from 0 to 100, or higher when the data does: Docker
 * gives CPU above 100% on a machine with several cores (101.5% was seen).
 */
export function percentCeiling(series: readonly ChartSeries[]): number {
  const top = Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.v)));
  return top > 100 ? Math.ceil(top / 10) * 10 : 100;
}

/** What the charts show: per strip, per container, its points. */
type Data = Record<string, Record<string, ChartSeries["points"]>>;

/** What the charts show, for the lanes and log panels beside them (REQ-000029-sJpO9KMY). */
export interface ChartsShown {
  stream: Stream;
  /** The followed containers shown (not hidden in the legend), in its order. */
  containers: string[];
  slots: SlotMap;
  /** The time range of the last read; a new object on each read. */
  view: Viewport;
  /** Hide a container, as its legend entry does. */
  hide: (name: string) => void;
}

/** The chart block's props. */
export interface ChartBlockProps {
  bridge: ShellBridge;
  /** Changes when the data streams changed elsewhere. */
  version?: number;
  /** Drawn in `#chart-block` under the charts: cttc's lanes. */
  lanes?: (shown: ChartsShown) => ReactNode;
  /** Drawn in `#layout` after `#chart-block`: cttc's `#panels`. */
  panels?: (shown: ChartsShown) => ReactNode;
}

/** The charts. */
export function ChartBlock({ bridge, version = 0, lanes, panels }: ChartBlockProps) {
  const [stream, setStream] = useState<Stream | null>(null);
  const [containers, setContainers] = useState<string[]>([]);
  const [slots, setSlots] = useState<SlotMap>({});
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [data, setData] = useState<Data>({});
  const [view, setView] = useState<Viewport>(() => viewEndingAt(Date.now()));
  const [size, setSize] = useState({ width: 0, height: 0 });
  const chartsRef = useRef<HTMLDivElement>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);

  const read = useCallback(async () => {
    const list = await listStreams(bridge.sump.request);
    if (!list.ok) return;
    const id = (await bridge.stream?.active()) ?? null;
    const active = list.value.find((s) => s.id === id) ?? null;
    setStream(active);
    const names = active?.followed?.containers ?? [];
    setContainers(names);
    setSlots((s) => assignSlots(s, names));
    const now = viewEndingAt(Date.now());
    setView(now);
    const plot = Math.max(1, (chartsRef.current?.clientWidth ?? 600) - PLOT_MARGIN_LEFT);
    const next: Data = {};
    await Promise.all(
      STRIPS.flatMap((strip) =>
        names.map(async (name) => {
          const reply = await bridge.sump.request({
            method: "GET",
            path: "/records/buckets",
            query: bucketsQuery(strip, `${active?.id}/${name}`, now, plot),
          });
          if (!reply.ok) return;
          const values = (reply.value as { values: (number | null)[] }).values;
          next[strip.key] = {
            ...(next[strip.key] ?? {}),
            [name]: bucketsToPoints(values, now, strip.scale),
          };
        }),
      ),
    );
    setData(next);
  }, [bridge]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a read.
  useEffect(() => {
    void read();
    const timer = setInterval(() => void read(), CHARTS_EVERY_MS);
    return () => clearInterval(timer);
  }, [read, version]);

  // The strips share the block's height, as cttc's computeStripH.
  useEffect(() => {
    const el = chartsRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      setSize({ width: el.clientWidth, height: el.clientHeight }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!size.width) return;
    const style = getComputedStyle(document.documentElement);
    const readVar = (name: string) => style.getPropertyValue(name).trim();
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const stripH = Math.max(
      STRIP_MIN_H,
      Math.floor((size.height - TIME_AXIS_HEIGHT) / STRIPS.length),
    );
    const ratio = window.devicePixelRatio || 1;
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
      const series = containers
        .filter((name) => !hidden.has(name))
        .map((name) => ({
          points: data[strip.key]?.[name] ?? [],
          color: resolveColor(colorForSlot(slots[name] ?? 0, dark), readVar),
        }));
      drawChartStrip(ctx, {
        view,
        series,
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
      // The strip's title at its top left, as cttc's strips.
      ctx.fillStyle = readVar("--text-secondary");
      ctx.font = "600 10px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(strip.title, PLOT_MARGIN_LEFT + 6, 4);
    });
  }, [size, data, containers, hidden, slots, view]);

  const empty = !stream
    ? "No data stream: New Data Stream… adds one."
    : containers.length === 0
      ? `Nothing followed on ${stream.label}: Edit Data Streams… picks containers.`
      : null;
  const hide = useCallback(
    (name: string) => setHidden((h) => (h.has(name) ? h : new Set([...h, name]))),
    [],
  );
  // Kept the same between reads, so the lanes and panels read only on a new view.
  const shown = useMemo<ChartsShown | null>(
    () =>
      stream
        ? { stream, containers: containers.filter((n) => !hidden.has(n)), slots, view, hide }
        : null,
    [stream, containers, hidden, slots, view, hide],
  );
  return (
    <main id="layout">
      <section id="chart-block">
        <div id="svc-graph" className="graph-block">
          <div id="chart-head">
            <span className="panel-head-title">Telemetry</span>
          </div>
          <div className="panel-head-divider" />
          <div id="legend">
            {containers.map((name) => {
              const off = hidden.has(name);
              return (
                // biome-ignore lint/a11y/useSemanticElements: cttc's legend entry is a span; it is a toggle button to assistive technology.
                <span
                  key={name}
                  className={off ? "legend-item off" : "legend-item"}
                  role="button"
                  tabIndex={0}
                  aria-pressed={!off}
                  title={off ? `Show ${name}` : `Hide ${name}`}
                  onClick={() => toggle(name)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle(name);
                    }
                  }}
                >
                  <span
                    className="legend-swatch"
                    style={{ background: colorForSlot(slots[name] ?? 0, false) }}
                  />
                  {name}
                </span>
              );
            })}
          </div>
          <div id="charts" ref={chartsRef}>
            {empty ? (
              <div id="empty-state" className="muted">
                {empty}
              </div>
            ) : null}
            {STRIPS.map((strip, i) => (
              <canvas
                key={strip.key}
                className="strip"
                data-strip={i}
                hidden={empty !== null}
                role="img"
                aria-label={`${strip.title}: ${containers.filter((n) => !hidden.has(n)).join(", ") || "nothing"}`}
                ref={(el) => {
                  canvases.current[i] = el;
                }}
              />
            ))}
          </div>
        </div>
        {shown && lanes ? lanes(shown) : null}
      </section>
      {shown && panels ? panels(shown) : null}
    </main>
  );

  function toggle(name: string) {
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }
}
