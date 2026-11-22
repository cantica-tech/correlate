/**
 * The telemetry charts (REQ-000028-sJpO9KMY Requirement 2), in cttc's markup
 * (`index.html:214-266`, `#chart-block`, `#svc-graph` with `#legend`,
 * `#charts` and `#chart-nav`, then `#host-block`): CPU %, MEM % and NET on
 * one timeline for the window's active data stream
 * (br-STREAM-000001-sJpO9KMY), one line per followed container in a stable
 * color, a legend that hides or shows a container in every strip. The data
 * comes from the Sump's buckets route, at most a plot's width of maxima per
 * series, read every 5 s; drawing is the ported `drawChartStrip`.
 *
 * The window's cursor (REQ-000030-sJpO9KMY): a click on a strip sets it, and
 * the log panels follow. The containers' order and hidden set are shared with
 * the panels and kept per Sump and stream.
 *
 * The live view (REQ-000031-sJpO9KMY, br-VIEW-000001-sJpO9KMY): centred 5 s
 * behind now and moved every second, the now line, live tracking's cursor; a
 * double-click or a row's click recentres and pauses, resuming after the
 * delay; a drag zooms; the navigator pans and its "now" goes live again.
 *
 * The host's own telemetry (REQ-000032-sJpO9KMY): cttc's host block under the
 * container charts, titled for the active stream's host, its own strips on
 * the same view and cursor, never mixed with the containers'.
 *
 * The analysis view (REQ-000033-sJpO9KMY): given `analysis`, the block shows
 * an opened file through a bridge answering from it; the view opens on the
 * file's range and is static (no now line, no live tracking, no movement,
 * no "now", br-ANLYS-000002-sJpO9KMY) and bounded to it
 * (br-ANLYS-000003-sJpO9KMY); "Back to live tracking" leaves it.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu } from "../components/index.js";
import type { Viewport } from "../correlate/atoms.js";
import { PLOT_MARGIN_LEFT } from "../correlate/axes.js";
import { assignSlots, colorForSlot, type SlotMap } from "../correlate/colorSlots.js";
import { rangeView } from "../correlate/zoom.js";
import { SnapshotDialog } from "../exports/SnapshotDialog.js";
import { type SnapshotOptions, takeSnapshot } from "../exports/snapshot.js";
import { Icon } from "../icons/Icon.js";
import { bandsAt, type Recorded } from "../recording/bands.js";
import type { CaptureRequest, LiveSettings, ShellBridge } from "../shell/bridge.js";
import { listStreams, type Stream } from "../streams/api.js";
import { type Arranged, arrange, DRAG_TYPE, moveBy, moveTo } from "./arrange.js";
import { HOST_NAME, hostCollected, hostTitle } from "./host.js";
import { type Cursor, StripCanvases, type StripData } from "./StripCanvases.js";
import { bucketsQuery, bucketsToPoints, STRIPS } from "./strips.js";
import { TimelineNav } from "./TimelineNav.js";
import {
  bounded,
  countdown,
  countdownText,
  fileState,
  frameOf,
  goLive,
  initialState,
  liveCursor,
  moved,
  navBounds,
  recentred,
  TICK_MS,
  tick,
  type ViewState,
} from "./viewState.js";

export { percentCeiling, timeAt, xAt } from "./StripCanvases.js";

/** How often the charts are read again: cttc's poll, 5 s. */
export const CHARTS_EVERY_MS = 5_000;
/** Rows this close to the cursor are highlighted until the settings say: cttc's default, 5 s. */
export const HIGHLIGHT_MS = 5_000;
/** cttc's defaults, until the main process answers. */
const LIVE_DEFAULTS: LiveSettings = {
  windowSecs: 5,
  liveTrack: true,
  liveTrackSecs: 0,
  resumeSecs: 10,
};
/** The host's one line, in the first series color: its block has no other. */
const HOST_LINES = [{ name: HOST_NAME, slot: 0 }];

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
  /** Capture mode is armed: the next drag captures (REQ-000041-sJpO9KMY). */
  captureArmed: boolean;
  /** Capture a dragged range (br-EXPORT-000003-sJpO9KMY). */
  capture: (ta: number, tb: number) => void;
  /** cttc's time menu at `x`, `y` for time `t`: Capture metrics, Take snapshot. */
  timeMenu: (x: number, y: number, t: number) => void;
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
  /** The host block is open (cttc's ▾), kept by the shell (REQ-000032-sJpO9KMY). */
  hostOpen?: boolean;
  onHostToggle?: (open: boolean) => void;
  /** The analysis view: the opened file's range; `bridge` answers from the file. */
  analysis?: { from: number; to: number } | null;
  /** "Back to live tracking" (REQ-000033-sJpO9KMY). */
  onBackToLive?: () => void;
  /** cttc's Export metrics button, in the analysis view's head (REQ-000042-sJpO9KMY). */
  onExportMetrics?: () => void;
  /**
   * The recording transport, in the live view's head (REQ-000037-sJpO9KMY),
   * given what Start would record: the active stream, its followed
   * containers, and whether its host is read.
   */
  transport?: (target: { stream: string; containers: string[]; host: boolean } | null) => ReactNode;
  /** Capture a range of what the view shows (REQ-000041-sJpO9KMY): the Shell saves and adds it. */
  onCapture?: (request: CaptureRequest) => void;
  /** Capture mode armed or not: the status bar says it (REQ-000041-sJpO9KMY). */
  onCaptureMode?: (armed: boolean) => void;
  /** What the recording has captured, banded on the live view (REQ-000040-sJpO9KMY). */
  recorded?: Recorded | null;
  /** A legend entry's right-click: the track's menu (REQ-000035-sJpO9KMY). */
  onLegendMenu?: (name: string, x: number, y: number) => void;
  /** The live view to start from (the one saved when a file was opened). */
  initialView?: ViewState | null;
  /** Told of every change of the view, so the shell can keep the live one. */
  onViewState?: (state: ViewState) => void;
}

/** The buckets of `names` within `stream` over `view`, per strip and name. */
async function readStrips(
  bridge: ShellBridge,
  stream: string,
  names: readonly string[],
  view: Viewport,
  plot: number,
): Promise<StripData> {
  const fetched: StripData = {};
  await Promise.all(
    STRIPS.flatMap((strip) =>
      names.map(async (name) => {
        const reply = await bridge.sump.request({
          method: "GET",
          path: "/records/buckets",
          query: bucketsQuery(strip, `${stream}/${name}`, view, plot),
        });
        if (!reply.ok) return;
        const values = (reply.value as { values: (number | null)[] }).values;
        fetched[strip.key] = {
          ...(fetched[strip.key] ?? {}),
          [name]: bucketsToPoints(values, view, strip.scale),
        };
      }),
    ),
  );
  return fetched;
}

/** The charts. */
export function ChartBlock({
  bridge,
  version = 0,
  lanes,
  panels,
  onLiveStatus,
  hostOpen = true,
  onHostToggle,
  analysis = null,
  onBackToLive,
  onExportMetrics,
  onLegendMenu,
  transport,
  recorded = null,
  onCapture,
  onCaptureMode,
  initialView = null,
  onViewState,
}: ChartBlockProps) {
  const [stream, setStream] = useState<Stream | null>(null);
  const [containers, setContainers] = useState<string[]>([]);
  const [slots, setSlots] = useState<SlotMap>({});
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [data, setData] = useState<StripData>({});
  const [hostData, setHostData] = useState<StripData>({});
  const [vs, setVsState] = useState<ViewState>(() =>
    analysis ? fileState(analysis) : (initialView ?? initialState(Date.now())),
  );
  const [dataView, setDataView] = useState<Viewport>(() => vs.view);
  const [dataRange, setDataRange] = useState<{ from: number; to: number } | null>(null);
  const [nowT, setNowT] = useState(() => Date.now());
  const [cursor, setCursorState] = useState<Cursor | null>(null);
  const [live, setLive] = useState<LiveSettings>(LIVE_DEFAULTS);
  const chartsBox = useRef<HTMLDivElement>(null);
  const vsRef = useRef(vs);
  const liveRef = useRef(live);
  liveRef.current = live;
  const arrangedRef = useRef<Arranged>({ order: [], hidden: [] });
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const statusRef = useRef("");
  const onLiveStatusRef = useRef(onLiveStatus);
  onLiveStatusRef.current = onLiveStatus;
  const analysisRef = useRef(analysis);
  analysisRef.current = analysis;
  const onViewStateRef = useRef(onViewState);
  onViewStateRef.current = onViewState;

  // In the analysis view every view is kept within the file (br-ANLYS-000003-sJpO9KMY).
  const setVs = useCallback((next: ViewState) => {
    const range = analysisRef.current ? frameOf(analysisRef.current) : null;
    const kept = range
      ? { ...next, view: bounded(next.view, range), live: false, resumeAt: null }
      : next;
    vsRef.current = kept;
    setVsState(kept);
    onViewStateRef.current?.(kept);
  }, []);
  const currentView = useCallback(() => vsRef.current.view, []);

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
    if (!active) {
      setData({});
      setHostData({});
      return;
    }
    const plot = Math.max(1, (chartsBox.current?.clientWidth ?? 600) - PLOT_MARGIN_LEFT);
    const withHost = hostCollected(active);
    const sources = [...names, ...(withHost ? [HOST_NAME] : [])].map((n) => `${active.id}/${n}`);
    if (sources.length > 0) {
      void bridge.sump
        .request({ method: "GET", path: "/records/range", query: { sources: sources.join(",") } })
        .then((reply) => {
          const r = reply.ok ? (reply.value as { from: string | null; to: string | null }) : null;
          setDataRange(r?.from && r.to ? { from: Date.parse(r.from), to: Date.parse(r.to) } : null);
        });
    }
    const [containerData, host] = await Promise.all([
      readStrips(bridge, active.id, names, next, plot),
      withHost ? readStrips(bridge, active.id, [HOST_NAME], next, plot) : Promise.resolve({}),
    ]);
    setData(containerData);
    setHostData(host);
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
      // The analysis view is static: nothing moves with time (br-ANLYS-000002-sJpO9KMY).
      if (analysisRef.current) return;
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
  /** A thumb drag in progress: moved, read when it ends. */
  const drag = useCallback(
    (next: Viewport) => {
      const state = moved(next);
      if (state) setVs(state);
    },
    [setVs],
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
    // Nothing in the analysis view goes to the present (cttc bug 16).
    if (analysisRef.current) return;
    setVs(goLive(vsRef.current, Date.now(), true));
    void read();
  };

  const view = vs.view;
  // The analysis view's navigator spans the file, not now (br-ANLYS-000003-sJpO9KMY).
  // The file's frame is also its bounds (br-ANLYS-000003-sJpO9KMY, br-ANLYS-000004-sJpO9KMY).
  const frame = analysis ? frameOf(analysis) : null;
  const bounds = frame ? { lo: frame.from, hi: frame.to } : navBounds(view, dataRange, nowT);
  // No now line in the analysis view; NaN is in no view.
  const shownNow = analysis ? Number.NaN : nowT;
  const windowMs = live.windowSecs * 1000;
  const cursorT = cursor?.t ?? null;
  const cursorLive = cursor?.live ?? false;
  const shownNames = useMemo(() => containers.filter((n) => !hidden.has(n)), [containers, hidden]);
  const lines = useMemo(
    () => shownNames.map((name) => ({ name, slot: slots[name] ?? 0 })),
    [shownNames, slots],
  );
  const empty = !stream
    ? "No data stream: New Data Stream… adds one."
    : containers.length === 0
      ? `Nothing followed on ${stream.label}: Edit Data Streams… picks containers.`
      : null;
  const withHost = hostCollected(stream);
  const hostLoading =
    withHost && !Object.values(hostData).some((byName) => byName[HOST_NAME]?.length);
  // Snapshots and capture (REQ-000041-sJpO9KMY): cttc's time menu, capture
  // mode, and the snapshot dialog, all of what this view shows.
  const [armed, setArmed] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; t: number } | null>(null);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  const hostShown = withHost && hostOpen;
  const onCaptureRef = useRef(onCapture);
  onCaptureRef.current = onCapture;
  const onCaptureModeRef = useRef(onCaptureMode);
  onCaptureModeRef.current = onCaptureMode;
  useEffect(() => {
    onCaptureModeRef.current?.(armed);
    document.body.classList.toggle("sample-armed", armed);
    if (!armed) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setArmed(false);
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [armed]);
  const captureRange = useCallback(
    (ta: number, tb: number) => {
      setArmed(false);
      if (!stream) return;
      onCaptureRef.current?.({
        view: analysis ? "file" : "live",
        stream: stream.id,
        containers: shownNames,
        host: hostShown,
        from: Math.min(ta, tb),
        to: Math.max(ta, tb),
      });
    },
    [stream, analysis, shownNames, hostShown],
  );
  const timeMenu = useCallback((x: number, y: number, t: number) => setMenuAt({ x, y, t }), []);
  const takeAt = useCallback(
    (t: number, options: SnapshotOptions) => {
      if (!stream) return Promise.reject(new Error("no data stream"));
      return takeSnapshot(
        {
          request: bridge.sump.request,
          stream: stream.id,
          containers: shownNames,
          host: hostShown ? { label: hostTitle(stream).replace(/^Host telemetry — /, "") } : null,
          view: currentView(),
        },
        t,
        options,
      );
    },
    [bridge, stream, shownNames, hostShown, currentView],
  );
  const saveSnapshot = useCallback(
    (snapshot: { name: string; content: string; kind: "txt" | "json" }) => {
      void bridge.exports?.saveSnapshot(snapshot).then((r) => {
        if (r.ok) void bridge.status.add(`snapshot saved: ${r.file}`);
        else if (!r.cancelled) void bridge.status.add(`snapshot save failed: ${r.message}`);
      });
    },
    [bridge],
  );
  const strips = {
    view,
    currentView,
    cursor,
    nowT: shownNow,
    bands: analysis ? [] : bandsAt(recorded, stream?.id, nowT),
    onCursor: setCursor,
    onZoom: zoomTo,
    onRecenter: recenterAt,
    captureArmed: armed,
    onCapture: captureRange,
    onTimeMenu: timeMenu,
  };
  const nav = {
    view,
    currentView,
    bounds,
    live: vs.live,
    resuming: vs.resumeAt !== null,
    onPan: pan,
    onDrag: drag,
    onPanned: () => void read(),
    onNow: nowLive,
    showNow: !analysis,
  };
  const shown = useMemo<ChartsShown | null>(
    () =>
      stream
        ? {
            stream,
            containers: shownNames,
            slots,
            view: dataView,
            shownView: view,
            nowT: shownNow,
            cursorT,
            cursorLive,
            windowMs,
            setCursor,
            recenter,
            recenterAt,
            zoomTo,
            hide,
            reorder,
            captureArmed: armed,
            capture: captureRange,
            timeMenu,
          }
        : null,
    [
      stream,
      shownNames,
      slots,
      dataView,
      view,
      shownNow,
      cursorT,
      cursorLive,
      windowMs,
      setCursor,
      recenter,
      recenterAt,
      zoomTo,
      hide,
      reorder,
      armed,
      captureRange,
      timeMenu,
    ],
  );
  return (
    <main id="layout">
      <section id="chart-block">
        <div id="svc-graph" className="graph-block" ref={chartsBox}>
          <div id="chart-head">
            <span className="panel-head-title">Telemetry</span>
            {!analysis && transport ? (
              <div className="panel-head-right">
                {transport(
                  stream
                    ? {
                        stream: stream.id,
                        containers: stream.followed?.containers ?? [],
                        host: hostCollected(stream),
                      }
                    : null,
                )}
              </div>
            ) : null}
            {analysis ? (
              <div className="panel-head-right">
                <button
                  type="button"
                  id="btn-back-to-live"
                  className="flat-action"
                  title="Currently in analysis mode -- click to show live data again"
                  onClick={onBackToLive}
                >
                  <Icon name="track" svgClassName="flat-action-icon" />
                  Back to live tracking
                </button>
                {onExportMetrics ? (
                  <button
                    type="button"
                    id="btn-export-metrics"
                    className="icon-btn"
                    title="Export this metrics file's stats/logs as text or JSON"
                    onClick={onExportMetrics}
                  >
                    <Icon name="export" />
                  </button>
                ) : null}
              </div>
            ) : null}
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
                  onContextMenu={
                    onLegendMenu
                      ? (e) => {
                          e.preventDefault();
                          onLegendMenu(name, e.clientX, e.clientY);
                        }
                      : undefined
                  }
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
          <StripCanvases
            id="charts"
            lines={lines}
            data={data}
            empty={empty !== null}
            label={shownNames.join(", ") || "nothing"}
            {...strips}
          >
            {empty ? (
              <div id="empty-state" className="muted">
                {empty}
              </div>
            ) : null}
          </StripCanvases>
          <TimelineNav id="chart-nav" {...nav} />
        </div>
        {shown && lanes ? lanes(shown) : null}
        {stream && withHost ? (
          <div id="host-block" className="graph-block">
            <div id="host-head">
              <span id="host-title" className="panel-head-title">
                {hostTitle(stream)}
              </span>
              <div className="panel-head-right">
                <button
                  type="button"
                  id="btn-host-toggle"
                  className="icon-btn"
                  title={hostOpen ? "Hide host telemetry" : "Show host telemetry"}
                  aria-expanded={hostOpen}
                  onClick={() => onHostToggle?.(!hostOpen)}
                >
                  {hostOpen ? "▾" : "▸"}
                </button>
              </div>
            </div>
            <div className="panel-head-divider" />
            <StripCanvases
              id="host-charts"
              lines={HOST_LINES}
              data={hostData}
              hidden={!hostOpen || hostLoading}
              label={hostTitle(stream)}
              {...strips}
            />
            <div id="host-loading" className="muted" hidden={!(hostOpen && hostLoading)}>
              <span className="hourglass">⏳</span> Loading host telemetry…
            </div>
            <TimelineNav id="host-nav" hidden={!hostOpen || hostLoading} {...nav} />
          </div>
        ) : null}
      </section>
      {shown && panels ? panels(shown) : null}
      {menuAt ? (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          label="Time"
          entries={[
            { label: "✂ Capture metrics", onSelect: () => setArmed(true) },
            { label: "📸 Take snapshot at this time", onSelect: () => setSnapAt(menuAt.t) },
          ]}
          onClose={() => setMenuAt(null)}
        />
      ) : null}
      <SnapshotDialog
        at={snapAt}
        take={takeAt}
        save={saveSnapshot}
        onClose={() => setSnapAt(null)}
      />
    </main>
  );
}
