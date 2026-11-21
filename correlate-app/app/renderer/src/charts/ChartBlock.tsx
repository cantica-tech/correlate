/**
 * The telemetry charts (REQ-000028-sJpO9KMY Requirement 2), in cttc's markup
 * (`index.html:214-245`, `#chart-block`, `#legend`, `#charts` of
 * `canvas.strip`, `#chart-nav`): CPU %, MEM % and NET on one timeline for the
 * window's active data stream (br-STREAM-000001-sJpO9KMY), one line per
 * followed container in a stable color, a legend that hides or shows a
 * container in every strip. The data comes from the Sump's buckets route, at
 * most a plot's width of maxima per series, read every 5 s; drawing is the
 * ported `drawChartStrip`.
 *
 * The window's cursor (REQ-000030-sJpO9KMY): a click on a strip sets it, and
 * the log panels follow. The containers' order and hidden set are shared with
 * the panels and kept per Sump and stream.
 *
 * The live view (REQ-000031-sJpO9KMY, br-VIEW-000001-sJpO9KMY): centred 5 s
 * behind now and moved every second, the now line, live tracking's cursor; a
 * double-click or a row's click recentres and pauses, resuming after the
 * delay; a drag zooms; the navigator pans and its "now" goes live again.
 */
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Viewport } from "../correlate/atoms.js";
import { PLOT_MARGIN_LEFT, TIME_AXIS_HEIGHT } from "../correlate/axes.js";
import { type ChartSeries, drawChartStrip } from "../correlate/chartDraw.js";
import { assignSlots, colorForSlot, resolveColor, type SlotMap } from "../correlate/colorSlots.js";
import { tToX, xToT } from "../correlate/timeMapping.js";
import { isClick, panBy, rangeView } from "../correlate/zoom.js";
import type { LiveSettings, ShellBridge } from "../shell/bridge.js";
import { listStreams, type Stream } from "../streams/api.js";
import { type Arranged, arrange, DRAG_TYPE, moveBy, moveTo } from "./arrange.js";
import { drawCursorMark, drawNowMark } from "./marks.js";
import { bucketsQuery, bucketsToPoints, STRIPS } from "./strips.js";
import {
  countdown,
  countdownText,
  goLive,
  initialState,
  liveCursor,
  moved,
  navBounds,
  recentred,
  TICK_MS,
  thumbOf,
  tick,
  type ViewState,
  viewAtTrack,
  viewDragged,
} from "./viewState.js";

/** How often the charts are read again: cttc's poll, 5 s. */
export const CHARTS_EVERY_MS = 5_000;
/** A strip is never shorter than cttc's 44 px. */
const STRIP_MIN_H = 44;
/** Rows this close to the cursor are highlighted until the settings say: cttc's default, 5 s. */
export const HIGHLIGHT_MS = 5_000;
/** cttc's defaults, until the main process answers. */
const LIVE_DEFAULTS: LiveSettings = {
  windowSecs: 5,
  liveTrack: true,
  liveTrackSecs: 0,
  resumeSecs: 10,
};

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

/** What the charts show: per strip, per container, its points. */
type Data = Record<string, Record<string, ChartSeries["points"]>>;

/** The cursor, and whether live tracking put it there. */
interface Cursor {
  t: number;
  live: boolean;
}

/** What the charts show, for the lanes and log panels beside them (REQ-000029-sJpO9KMY). */
export interface ChartsShown {
  stream: Stream;
  /** The followed containers shown (not hidden in the legend), in its order. */
  containers: string[];
  slots: SlotMap;
  /** The time range of the last read, what the rows are asked over; a new object on each read. */
  view: Viewport;
  /** The time range drawn, which a live view moves every second (REQ-000031-sJpO9KMY). */
  shownView: Viewport;
  /** Now, as of the last tick, for the now line. */
  nowT: number;
  /** The window's cursor, or null (REQ-000030-sJpO9KMY). */
  cursorT: number | null;
  /** Live tracking put the cursor there. */
  cursorLive: boolean;
  /** Rows this close to the cursor are highlighted, in ms (the Time window setting). */
  windowMs: number;
  /** Set the cursor; the panels follow. */
  setCursor: (t: number) => void;
  /** Set the cursor and centre the view on it, pausing a live view (a row's click). */
  recenter: (t: number) => void;
  /** Centre the view on `t`, pausing a live view (a double-click). */
  recenterAt: (t: number) => void;
  /** Zoom to a dragged range; refused under 200 ms. */
  zoomTo: (ta: number, tb: number) => void;
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
  /** The status bar's persistent text: a pause's countdown, or "" (REQ-000031-sJpO9KMY). */
  onLiveStatus?: (text: string) => void;
}

/** The charts. */
export function ChartBlock({ bridge, version = 0, lanes, panels, onLiveStatus }: ChartBlockProps) {
  const [stream, setStream] = useState<Stream | null>(null);
  const [containers, setContainers] = useState<string[]>([]);
  const [slots, setSlots] = useState<SlotMap>({});
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [data, setData] = useState<Data>({});
  const [vs, setVsState] = useState<ViewState>(() => initialState(Date.now()));
  const [dataView, setDataView] = useState<Viewport>(() => vs.view);
  const [dataRange, setDataRange] = useState<{ from: number; to: number } | null>(null);
  const [nowT, setNowT] = useState(() => Date.now());
  const [cursor, setCursorState] = useState<Cursor | null>(null);
  const [live, setLive] = useState<LiveSettings>(LIVE_DEFAULTS);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const chartsRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const vsRef = useRef(vs);
  const liveRef = useRef(live);
  liveRef.current = live;
  const arrangedRef = useRef<Arranged>({ order: [], hidden: [] });
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const downX = useRef<number | null>(null);
  const statusRef = useRef("");
  const onLiveStatusRef = useRef(onLiveStatus);
  onLiveStatusRef.current = onLiveStatus;

  const setVs = useCallback((next: ViewState) => {
    vsRef.current = next;
    setVsState(next);
  }, []);

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
    const next = { ...vsRef.current.view };
    setDataView(next);
    const plot = Math.max(1, (chartsRef.current?.clientWidth ?? 600) - PLOT_MARGIN_LEFT);
    const sources = names.map((name) => `${active?.id}/${name}`);
    if (sources.length > 0) {
      void bridge.sump
        .request({ method: "GET", path: "/records/range", query: { sources: sources.join(",") } })
        .then((reply) => {
          const r = reply.ok ? (reply.value as { from: string | null; to: string | null }) : null;
          setDataRange(r?.from && r.to ? { from: Date.parse(r.from), to: Date.parse(r.to) } : null);
        });
    }
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

  // The live settings, kept by the main process (REQ-000031-sJpO9KMY Requirement 4).
  useEffect(() => {
    if (!bridge.live) return;
    let on = true;
    void bridge.live.get().then((s) => {
      if (on) setLive(s);
    });
    const stop = bridge.live.onChanged(setLive);
    return () => {
      on = false;
      stop();
    };
  }, [bridge]);

  // cttc's 1 s ticker: a live view moves, a pause's time may come, live
  // tracking moves the cursor, and the countdown is told.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const before = vsRef.current;
      const after = tick(before, now);
      if (after !== before) setVs(after);
      if (!before.live && after.live) void read();
      setNowT(now);
      const t = liveCursor(after, now, liveRef.current);
      if (t !== null) setCursorState({ t, live: true });
      const left = countdown(after, now);
      const text = left === null ? "" : countdownText(left);
      if (text !== statusRef.current) {
        statusRef.current = text;
        onLiveStatusRef.current?.(text);
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [read, setVs]);

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

  const view = vs.view;
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
      // cttc's drawVerticals: the cursor, then the now line, over the plot.
      const plotH = height - (last ? TIME_AXIS_HEIGHT : 0);
      if (cursor && inView(cursor.t)) {
        drawCursorMark(
          ctx,
          xAt(cursor.t, view, size.width),
          plotH,
          cursor.live,
          readVar("--accent"),
        );
      }
      if (inView(nowT)) drawNowMark(ctx, xAt(nowT, view, size.width), plotH);
      // The strip's title at its top left, as cttc's strips.
      ctx.fillStyle = readVar("--text-secondary");
      ctx.font = "600 10px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(strip.title, PLOT_MARGIN_LEFT + 6, 4);
    });
  }, [size, data, containers, hidden, slots, view, cursor, nowT]);

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
  const setCursor = useCallback((t: number) => setCursorState({ t, live: false }), []);
  /** A pan or zoom: the view stops following now, and is read at once. */
  const pan = useCallback(
    (next: Viewport) => {
      const state = moved(next);
      if (!state) return;
      setVs(state);
      void read();
    },
    [read, setVs],
  );
  const recenterAt = useCallback(
    (t: number) => {
      setVs(recentred(vsRef.current, t, Date.now(), liveRef.current.resumeSecs));
      void read();
    },
    [read, setVs],
  );
  const recenter = useCallback(
    (t: number) => {
      setCursorState({ t, live: false });
      recenterAt(t);
    },
    [recenterAt],
  );
  const zoomTo = useCallback(
    (ta: number, tb: number) => {
      const next = rangeView(ta, tb);
      if (next) pan(next);
    },
    [pan],
  );
  const nowLive = () => {
    setVs(goLive(vsRef.current, Date.now(), true));
    void read();
  };

  // The navigator's thumb, placed by script (the page's CSP forbids style attributes).
  const bounds = navBounds(view, dataRange, nowT);
  const placeThumb = (el: HTMLDivElement | null) => {
    const width = trackRef.current?.clientWidth ?? 0;
    if (!el || !width) return;
    const thumb = thumbOf(view, bounds, width);
    el.style.left = `${thumb.left}px`;
    el.style.width = `${thumb.width}px`;
  };
  const dragThumb = (e: ReactMouseEvent) => {
    e.stopPropagation();
    const startX = e.clientX;
    const start = vsRef.current.view;
    const width = trackRef.current?.clientWidth ?? 1;
    const fixed = bounds;
    const move = (ev: MouseEvent) => {
      const next = moved(viewDragged(start, fixed, ev.clientX - startX, width));
      if (next) setVs(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      void read();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const windowMs = live.windowSecs * 1000;
  const cursorT = cursor?.t ?? null;
  const cursorLive = cursor?.live ?? false;
  const empty = !stream
    ? "No data stream: New Data Stream… adds one."
    : containers.length === 0
      ? `Nothing followed on ${stream.label}: Edit Data Streams… picks containers.`
      : null;
  const shown = useMemo<ChartsShown | null>(
    () =>
      stream
        ? {
            stream,
            containers: containers.filter((n) => !hidden.has(n)),
            slots,
            view: dataView,
            shownView: view,
            nowT,
            cursorT,
            cursorLive,
            windowMs,
            setCursor,
            recenter,
            recenterAt,
            zoomTo,
            hide,
            reorder,
          }
        : null,
    [
      stream,
      containers,
      hidden,
      slots,
      dataView,
      view,
      nowT,
      cursorT,
      cursorLive,
      windowMs,
      setCursor,
      recenter,
      recenterAt,
      zoomTo,
      hide,
      reorder,
    ],
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
                  if (from === null) return;
                  const width = e.currentTarget.clientWidth;
                  const current = vsRef.current.view;
                  // cttc's timelineUp: a drag zooms to its range, a click sets the cursor.
                  if (!isClick(from, x)) {
                    const ta = timeAt(Math.max(PLOT_MARGIN_LEFT, from), current, width);
                    const tb = timeAt(Math.max(PLOT_MARGIN_LEFT, x), current, width);
                    if (ta !== null && tb !== null) zoomTo(ta, tb);
                    return;
                  }
                  const t = timeAt(x, current, width);
                  if (t !== null) setCursor(t);
                }}
                onDoubleClick={(e) => {
                  const t = timeAt(
                    e.nativeEvent.offsetX,
                    vsRef.current.view,
                    e.currentTarget.clientWidth,
                  );
                  if (t !== null) recenterAt(t);
                }}
              />
            ))}
          </div>
          <div
            id="chart-nav"
            className="timeline-nav"
            title="Drag the thumb or click the track to pan · click “now” to jump to the present and resume following it"
          >
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: the thumb's arrow keys pan from the keyboard. */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: cttc's track; the thumb is the slider. */}
            <div
              className="tl-track"
              ref={trackRef}
              onClick={(e) => {
                if (e.target !== e.currentTarget) return;
                const rect = e.currentTarget.getBoundingClientRect();
                pan(viewAtTrack(view, bounds, (e.clientX - rect.left) / rect.width));
              }}
            >
              <div
                className="tl-thumb"
                ref={placeThumb}
                role="slider"
                tabIndex={0}
                aria-label="The view in time"
                aria-valuemin={bounds.lo}
                aria-valuemax={bounds.hi}
                aria-valuenow={view.t0}
                aria-valuetext={`${new Date(view.t0).toLocaleTimeString()} to ${new Date(view.t1).toLocaleTimeString()}`}
                onMouseDown={dragThumb}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                  e.preventDefault();
                  pan(panBy(view, e.key === "ArrowLeft" ? -0.1 : 0.1));
                }}
              />
              {/* biome-ignore lint/a11y/useSemanticElements: cttc's now label is a span; a button to assistive technology. */}
              <span
                className="tl-now-label"
                data-live={String(vs.live)}
                role="button"
                tabIndex={0}
                title={
                  !vs.live && vs.resumeAt
                    ? "Live tracking paused -- see the status bar for the resume countdown, or click to jump now"
                    : vs.live
                      ? "Following the present -- click to jump anyway"
                      : "Jump back to the present and resume following it"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  nowLive();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    nowLive();
                  }
                }}
              >
                now
              </span>
            </div>
          </div>
        </div>
        {shown && lanes ? lanes(shown) : null}
      </section>
      {shown && panels ? panels(shown) : null}
    </main>
  );
}
