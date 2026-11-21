/**
 * The telemetry charts (REQ-000028-sJpO9KMY Requirement 2), in cttc's markup
 * (`index.html:214-227`, `#chart-block`, `#legend`, `#charts` of
 * `canvas.strip`): CPU %, MEM % and NET on one timeline for the window's
 * active data stream (br-STREAM-000001-sJpO9KMY), one line per followed
 * container in a stable color, a legend that hides or shows a container in
 * every strip. The data comes from the Sump's buckets route, at most a plot's
 * width of maxima per series, read again every 5 s; drawing is the ported
 * `drawChartStrip`.
 *
 * The window's cursor (REQ-000030-sJpO9KMY): a click on a strip sets it, and
 * the log panels follow; a click on a row sets it and recentres the view,
 * which then stops following now until "Now". The containers' order and
 * hidden set are shared with the panels and kept per Sump and stream.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Viewport } from "../correlate/atoms.js";
import { PLOT_MARGIN_LEFT, TIME_AXIS_HEIGHT } from "../correlate/axes.js";
import { type ChartSeries, drawChartStrip } from "../correlate/chartDraw.js";
import { assignSlots, colorForSlot, resolveColor, type SlotMap } from "../correlate/colorSlots.js";
import { xToT } from "../correlate/timeMapping.js";
import { isClick, MIN_SPAN_MS } from "../correlate/zoom.js";
import { Icon } from "../icons/Icon.js";
import type { ShellBridge } from "../shell/bridge.js";
import { listStreams, type Stream } from "../streams/api.js";
import { type Arranged, arrange, DRAG_TYPE, moveBy, moveTo } from "./arrange.js";
import { bucketsQuery, bucketsToPoints, STRIPS, viewEndingAt } from "./strips.js";

/** How often the charts are read again: cttc's poll, 5 s. */
export const CHARTS_EVERY_MS = 5_000;
/** A strip is never shorter than cttc's 44 px. */
const STRIP_MIN_H = 44;
/** Rows this close to the cursor are highlighted: cttc's default, 5 s. */
export const HIGHLIGHT_MS = 5_000;

/**
 * A percentage strip runs from 0 to 100, or higher when the data does: Docker
 * gives CPU above 100% on a machine with several cores (101.5% was seen).
 */
export function percentCeiling(series: readonly ChartSeries[]): number {
  const top = Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.v)));
  return top > 100 ? Math.ceil(top / 10) * 10 : 100;
}

/** The view centred on `t`, `view`'s span kept (cttc's `recenterOn`), never under 200 ms. */
export function recentred(view: Viewport, t: number): Viewport {
  const span = Math.max(MIN_SPAN_MS, view.t1 - view.t0);
  return { t0: t - span / 2, t1: t + span / 2 };
}

/** The time at `x` px of a canvas `width` px wide, or null left of the plot. */
export function timeAt(x: number, view: Viewport, width: number): number | null {
  if (x < PLOT_MARGIN_LEFT) return null;
  return xToT(x - PLOT_MARGIN_LEFT, view, Math.max(1, width - PLOT_MARGIN_LEFT));
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
  /** The window's cursor, or null (REQ-000030-sJpO9KMY). */
  cursorT: number | null;
  /** Set the cursor; the panels follow. */
  setCursor: (t: number) => void;
  /** Set the cursor and centre the view on it (a row's click). */
  recenter: (t: number) => void;
  /** Hide a container, as its legend entry does. */
  hide: (name: string) => void;
  /** Move a container to where `target` is, in the legend and the panels. */
  reorder: (name: string, target: string) => void;
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
  const [view, setViewState] = useState<Viewport>(() => viewEndingAt(Date.now()));
  const [following, setFollowing] = useState(true);
  const [cursorT, setCursorT] = useState<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const chartsRef = useRef<HTMLDivElement>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const viewRef = useRef(view);
  const followingRef = useRef(true);
  const arrangedRef = useRef<Arranged>({ order: [], hidden: [] });
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const downX = useRef<number | null>(null);

  const read = useCallback(async () => {
    const list = await listStreams(bridge.sump.request);
    if (!list.ok) return;
    const id = (await bridge.stream?.active()) ?? null;
    const active = list.value.find((s) => s.id === id) ?? null;
    setStream(active);
    const names = active?.followed?.containers ?? [];
    // A change still being kept is waited for, so a read does not undo it.
    await saving.current;
    const kept = active && bridge.series ? await bridge.series.get(active.id) : arrangedRef.current;
    const arranged = arrange(names, kept);
    arrangedRef.current = arranged;
    setContainers(arranged.order);
    setHidden(new Set(arranged.hidden));
    setSlots((s) => assignSlots(s, names));
    const next = followingRef.current ? viewEndingAt(Date.now()) : { ...viewRef.current };
    viewRef.current = next;
    setViewState(next);
    const plot = Math.max(1, (chartsRef.current?.clientWidth ?? 600) - PLOT_MARGIN_LEFT);
    const fetched: Data = {};
    await Promise.all(
      STRIPS.flatMap((strip) =>
        names.map(async (name) => {
          const reply = await bridge.sump.request({
            method: "GET",
            path: "/records/buckets",
            query: bucketsQuery(strip, `${active?.id}/${name}`, next, plot),
          });
          if (!reply.ok) return;
          const values = (reply.value as { values: (number | null)[] }).values;
          fetched[strip.key] = {
            ...(fetched[strip.key] ?? {}),
            [name]: bucketsToPoints(values, next, strip.scale),
          };
        }),
      ),
    );
    setData(fetched);
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
        cursorT,
        cursorColor: readVar("--accent"),
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
  }, [size, data, containers, hidden, slots, view, cursorT]);

  /** Keep the arrangement for this stream, here at once and in the settings. */
  const keep = useCallback(
    (arranged: Arranged) => {
      arrangedRef.current = arranged;
      setContainers(arranged.order);
      setHidden(new Set(arranged.hidden));
      if (stream && bridge.series) {
        saving.current = bridge.series.set({ stream: stream.id, ...arranged }).catch(() => {});
      }
    },
    [bridge, stream],
  );
  const toggle = (name: string) => {
    const { order, hidden: off } = arrangedRef.current;
    keep({ order, hidden: off.includes(name) ? off.filter((n) => n !== name) : [...off, name] });
  };
  const hide = useCallback(
    (name: string) => {
      const { order, hidden: off } = arrangedRef.current;
      if (!off.includes(name)) keep({ order, hidden: [...off, name] });
    },
    [keep],
  );
  const reorder = useCallback(
    (name: string, target: string) => {
      const { order, hidden: off } = arrangedRef.current;
      keep({ order: moveTo(order, name, target), hidden: off });
    },
    [keep],
  );
  const setCursor = useCallback((t: number) => setCursorT(t), []);
  const recenter = useCallback(
    (t: number) => {
      setCursorT(t);
      followingRef.current = false;
      setFollowing(false);
      viewRef.current = recentred(viewRef.current, t);
      void read();
    },
    [read],
  );
  const followNow = () => {
    followingRef.current = true;
    setFollowing(true);
    void read();
  };

  const empty = !stream
    ? "No data stream: New Data Stream… adds one."
    : containers.length === 0
      ? `Nothing followed on ${stream.label}: Edit Data Streams… picks containers.`
      : null;
  // Kept the same between reads, so the lanes and panels read only on a new view.
  const shown = useMemo<ChartsShown | null>(
    () =>
      stream
        ? {
            stream,
            containers: containers.filter((n) => !hidden.has(n)),
            slots,
            view,
            cursorT,
            setCursor,
            recenter,
            hide,
            reorder,
          }
        : null,
    [stream, containers, hidden, slots, view, cursorT, setCursor, recenter, hide, reorder],
  );
  return (
    <main id="layout">
      <section id="chart-block">
        <div id="svc-graph" className="graph-block">
          <div id="chart-head">
            <span className="panel-head-title">Telemetry</span>
            {following ? null : (
              <div className="panel-head-right">
                <button
                  type="button"
                  className="btn-flat"
                  title="Follow now again: the view ends at the present and moves with it"
                  onClick={followNow}
                >
                  <Icon name="track" svgClassName="btn-flat-icon" />
                  Now
                </button>
              </div>
            )}
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
                  draggable
                  aria-pressed={!off}
                  title={`${off ? `Show ${name}` : `Hide ${name}`}; drag, or Alt+arrow, to move it`}
                  onClick={() => toggle(name)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle(name);
                    } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                      e.preventDefault();
                      const { order, hidden: h } = arrangedRef.current;
                      keep({
                        order: moveBy(order, name, e.key === "ArrowLeft" ? -1 : 1),
                        hidden: h,
                      });
                    }
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, name);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(e) => {
                    const dragged = e.dataTransfer.getData(DRAG_TYPE);
                    if (!dragged) return;
                    e.preventDefault();
                    reorder(dragged, name);
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
                onMouseDown={(e) => {
                  downX.current = e.nativeEvent.offsetX;
                }}
                onMouseUp={(e) => {
                  const x = e.nativeEvent.offsetX;
                  const from = downX.current;
                  downX.current = null;
                  // A drag is Item 32's zoom; a click sets the cursor (cttc's timelineUp).
                  if (from === null || !isClick(from, x)) return;
                  const t = timeAt(x, viewRef.current, e.currentTarget.clientWidth);
                  if (t !== null) setCursorT(t);
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
}
