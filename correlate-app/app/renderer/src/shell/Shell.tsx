/**
 * The app's shell (REQ-000021-sJpO9KMY): cttc's `#app-body`, the sidebar on
 * the side it docks to, its splitter, and the main content beside it; or, in
 * the detached window, the sidebar alone. The layout comes from the main
 * process and every change goes back to it, so both windows show the same.
 */
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChartBlock } from "../charts/ChartBlock.js";
import type { ViewState } from "../charts/viewState.js";
import { Button, ContextMenu, Dialog } from "../components/index.js";
import type { Artifact, SumpEvent } from "../events/api.js";
import { EventFormDialog } from "../events/EventFormDialog.js";
import { EventListDialog } from "../events/EventListDialog.js";
import { ExportMetricsDialog, type MetricsChoice } from "../exports/ExportMetricsDialog.js";
import { Lanes } from "../logs/Lanes.js";
import { Panels, useLogPrefs } from "../logs/Panels.js";
import { MenuBar } from "../menubar/MenuBar.js";
import { AbandonProvider, useConfirmAbandon } from "../recording/Abandon.js";
import { bandsAt, type Recorded, recordedOf } from "../recording/bands.js";
import { RecoveryDialog } from "../recording/RecoveryDialog.js";
import { Transport } from "../recording/Transport.js";
import { StatusBar } from "../statusbar/StatusBar.js";
import { pauseStream } from "../streams/api.js";
import { PromoteDialog } from "../streams/PromoteDialog.js";
import { RemoveDialog } from "../streams/RemoveDialog.js";
import { StreamsDialog } from "../streams/StreamsDialog.js";
import { setAppearance } from "../theme/appearance.js";
import type {
  CaptureRequest,
  LayoutChange,
  LiveSettings,
  ProjectState,
  RecordingState,
  ShellBridge,
  SidebarLayout,
  ThemeMode,
} from "./bridge.js";
import { DelayDialog } from "./DelayDialog.js";
import { PreferencesDialog } from "./PreferencesDialog.js";
import { ProjectTree, type TreeChange } from "./ProjectTree.js";
import { Sidebar } from "./Sidebar.js";

/** The splitter's bounds, as the main process checks them. */
const MIN_WIDTH = 120;
const MAX_WIDTH = 480;

/** Apply a change here at once; the main process's answer follows. */
function applyChange(layout: SidebarLayout, change: LayoutChange): SidebarLayout {
  return { ...layout, ...change, expanded: { ...layout.expanded, ...(change.expanded ?? {}) } };
}

/** The shell's props. */
export interface ShellProps {
  bridge: ShellBridge;
  /** The detached sidebar's window. */
  detached?: boolean;
}

/** The shell, asking before a recording is abandoned (REQ-000039-sJpO9KMY). */
export function Shell(props: ShellProps) {
  return (
    <AbandonProvider bridge={props.bridge}>
      <ShellBody {...props} />
    </AbandonProvider>
  );
}

/** The shell's body. */
function ShellBody({ bridge, detached = false }: ShellProps) {
  const confirmAbandon = useConfirmAbandon();
  const [layout, setLayout] = useState<SidebarLayout | null>(null);
  const [preferences, setPreferences] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [statusBar, setStatusBar] = useState(true);
  const [live, setLive] = useState<LiveSettings | null>(null);
  const [streams, setStreams] = useState<"new" | "edit" | null>(null);
  const [removing, setRemoving] = useState(false);
  const [promoting, setPromoting] = useState(false);
  // Events (REQ-000046-sJpO9KMY): the form (creating, or the event edited),
  // the list, and a version bumped by each firing or save.
  const [eventForm, setEventForm] = useState<{ editing: SumpEvent | null } | null>(null);
  const [eventList, setEventList] = useState(false);
  const [eventsVersion, setEventsVersion] = useState(0);
  const [activeStream, setActiveStream] = useState<string | null>(null);
  const [streamsVersion, setStreamsVersion] = useState(0);
  const streamsChanged = useCallback(() => setStreamsVersion((v) => v + 1), []);
  const logs = useLogPrefs(bridge);
  // A live view's pause countdown, held in the status bar (REQ-000031-sJpO9KMY).
  const [liveStatus, setLiveStatus] = useState("");
  // The window's project, its open files and the one shown, null for live
  // (REQ-000033-sJpO9KMY, REQ-000034-sJpO9KMY, REQ-000035-sJpO9KMY); `shown`
  // counts every show, so each one frames the file anew.
  const [project, setProject] = useState<ProjectState | null>(null);
  const [shown, setShown] = useState(0);
  const [tracksVersion, setTracksVersion] = useState(0);
  // Before a project with changes is replaced: Save, Discard or Cancel.
  const [asking, setAsking] = useState<(() => void) | null>(null);
  // A bound project's Sump, offered when it is not the window's.
  const [offer, setOffer] = useState<{ sump: string; stream: string } | null>(null);
  // A track's right-click menu and its Delay… dialog (REQ-000035-sJpO9KMY Requirement 5).
  const [trackMenu, setTrackMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const [delaying, setDelaying] = useState<{ name: string; secs: number } | null>(null);
  // The recording session (REQ-000037-sJpO9KMY), and what Start would record.
  const [recording, setRecording] = useState<RecordingState["status"]>("idle");
  // The Export metrics dialog, of the shown file (REQ-000042-sJpO9KMY).
  const [exportOpen, setExportOpen] = useState(false);
  // Capture mode, said in the status bar while armed (REQ-000041-sJpO9KMY).
  const [captureArmed, setCaptureArmed] = useState(false);
  // What it has captured, banded on the live view (REQ-000040-sJpO9KMY).
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  // A crash's interrupted recording, offered to resume until chosen or put off (REQ-000038-sJpO9KMY).
  const [interrupted, setInterrupted] = useState<{ sumpGone: boolean } | null>(null);
  const recordTarget = useRef<{ stream: string; containers: string[]; host: boolean } | null>(null);
  const files = project?.open ?? { files: [], active: null };
  const analysis = files.files.find((f) => f.path === files.active) ?? null;
  // The live view, kept while a file is shown, restored on the way back.
  const liveView = useRef<ViewState | null>(null);
  const keepLiveView = useCallback((state: ViewState) => {
    liveView.current = state;
  }, []);

  /** Take the main process's answer; say what went wrong; frame anew when a file is shown. */
  const take = useCallback(
    (r: ProjectState | undefined, framed = false) => {
      if (!r) return;
      setProject(r);
      for (const why of r.refused ?? []) void bridge.status.add(why);
      for (const warning of r.warnings ?? []) void bridge.status.add(warning);
      if (!r.ok && !r.cancelled && r.message) void bridge.status.add(r.message);
      if (framed && r.open.active) {
        setShown((n) => n + 1);
        setLiveStatus("");
      }
    },
    [bridge],
  );
  useEffect(() => {
    if (!detached) void bridge.project?.get().then((r) => take(r));
  }, [bridge, detached, take]);

  /** Another project is coming: its Sump offered when it is bound elsewhere. */
  const arrived = useCallback(
    async (r: ProjectState | undefined) => {
      take(r);
      const sump = r?.ok ? r.session.project.sump : null;
      if (!sump) return;
      const current = await bridge.sump.active();
      if (current?.id !== sump.id) setOffer({ sump: sump.id, stream: sump.stream });
    },
    [bridge, take],
  );
  /** Run `then` once the project's changes are saved or discarded (asked first). */
  const guard = useCallback(
    (then: () => void) => {
      if (project?.session.dirty) setAsking(() => then);
      else then();
    },
    [project],
  );
  const newProject = useCallback(
    () => guard(() => void bridge.project?.newProject().then((r) => take(r))),
    [bridge, guard, take],
  );
  const openProject = useCallback(
    () => guard(() => void bridge.project?.open().then(arrived)),
    [bridge, guard, arrived],
  );
  const openRecent = useCallback(
    (file: string) => guard(() => void bridge.project?.openFile(file).then(arrived)),
    [bridge, guard, arrived],
  );
  /**
   * Files the OS handed the app (REQ-000036-sJpO9KMY): the last project opens,
   * as Open Project… (unsaved changes asked about first); the captures join
   * the project, as Add Files…, the last shown.
   */
  const received = useCallback(
    (got: { files: string[]; ignored: string[] }) => {
      for (const file of got.ignored)
        void bridge.status.add(`Not a project or a recording: ${file}`);
      const projects = got.files.filter((f) => f.toLowerCase().endsWith(".correlator"));
      const captures = got.files.filter((f) => !f.toLowerCase().endsWith(".correlator"));
      const addCaptures = () => {
        if (captures.length > 0) void bridge.project?.addPaths(captures).then((r) => take(r, true));
      };
      const last = projects[projects.length - 1];
      if (last) {
        guard(
          () =>
            void bridge.project?.openFile(last).then(async (r) => {
              await arrived(r);
              addCaptures();
            }),
        );
      } else addCaptures();
    },
    [bridge, guard, take, arrived],
  );
  // Taken once the window is ready; later ones as they come.
  const receivedRef = useRef(received);
  receivedRef.current = received;
  useEffect(() => {
    if (detached || !bridge.opened) return;
    void bridge.opened.take().then((a) => receivedRef.current(a));
    return bridge.opened.onFiles((a) => receivedRef.current(a));
  }, [bridge, detached]);
  const saveProject = useCallback(
    () => void bridge.project?.save().then((r) => take(r)),
    [bridge, take],
  );
  const saveProjectAs = useCallback(
    () => void bridge.project?.saveAs().then((r) => take(r)),
    [bridge, take],
  );
  const addFiles = useCallback(
    () => void bridge.project?.addFiles().then((r) => take(r, true)),
    [bridge, take],
  );
  // cttc import (REQ-000055-sJpO9KMY): the summary said, the files shown.
  const importCttc = useCallback(
    () =>
      void bridge.project?.importCttc?.().then((r) => {
        take(r, true);
        if (r?.ok && r.message) void bridge.status.add(r.message);
      }),
    [bridge, take],
  );
  const showFile = useCallback(
    (id: string) => void bridge.project?.show(id).then((r) => take(r, true)),
    [bridge, take],
  );
  const changeProject = useCallback(
    (change: TreeChange | { op: "bind"; sump: string; stream: string }) =>
      void bridge.project?.change(change).then((r) => {
        const before = project?.open.active ?? null;
        take(r, r ? r.open.active !== before && r.open.active !== null : false);
      }),
    [bridge, take, project],
  );
  const bind = useCallback(async () => {
    const sump = await bridge.sump.active();
    const stream = await bridge.stream?.active();
    if (!sump || !stream)
      return void bridge.status.add("Pick a data stream first: the project binds to it");
    changeProject({ op: "bind", sump: sump.id, stream });
  }, [bridge, changeProject]);
  /** Switch the window to the bound project's Sump and stream (the offer is the confirmation). */
  const switchToBound = useCallback(async () => {
    if (!offer) return;
    setOffer(null);
    if (!(await confirmAbandon(`Switching to the project's Sump and data stream`))) return;
    const listed = await bridge.sump.list();
    if (!listed.some((s) => s.id === offer.sump)) {
      return void bridge.status.add(
        `The project's Sump ${offer.sump} is not in the catalog; nothing switched`,
      );
    }
    const r = await bridge.sump.switchTo({ id: offer.sump, confirmed: true });
    if (!r.ok) return void bridge.status.add(r.message);
    await bridge.stream?.setActive(offer.stream, true);
    streamsChanged();
  }, [bridge, offer, streamsChanged, confirmAbandon]);

  // A bridge answering from the shown file: the views ask it as they ask a Sump,
  // and nothing of it reaches one (br-ANLYS-000001-sJpO9KMY). Its tracks'
  // visibility is kept in the project (REQ-000035-sJpO9KMY).
  const fileBridge = useMemo<ShellBridge | null>(() => {
    const filesApi = bridge.analysis;
    const projectApi = bridge.project;
    if (!analysis || !filesApi || !projectApi) return null;
    return {
      ...bridge,
      sump: { ...bridge.sump, request: filesApi.request },
      stream: { active: async () => "file", setActive: async () => ({ ok: true }) },
      series: {
        get: async () => {
          const { tracks } = await projectApi.tracks();
          return { order: [], hidden: Object.keys(tracks).filter((n) => tracks[n]?.hidden) };
        },
        set: async ({ hidden }) => {
          const { item, tracks } = await projectApi.tracks();
          if (!item) return { ok: false };
          const names = new Set([...Object.keys(tracks), ...hidden]);
          for (const name of names) {
            const wanted = hidden.includes(name);
            if ((tracks[name]?.hidden ?? false) !== wanted) {
              // The tree shows the project as changed (unsaved) at once.
              take(
                await projectApi.change({ op: "setTrack", item, container: name, hidden: wanted }),
              );
            }
          }
          return { ok: true };
        },
      },
    };
  }, [bridge, analysis, take]);

  // The session, told by the main process; a saved recording joined the project.
  useEffect(() => {
    if (detached || !bridge.recording) return;
    // Offered once per interruption: Decide later is not asked again.
    let offered: number | null = null;
    const offer = (r: RecordingState) => {
      if (!r.interrupted) return setInterrupted(null);
      if (r.interrupted.restartAt === offered) return;
      offered = r.interrupted.restartAt;
      setInterrupted({ sumpGone: r.sumpGone === true });
    };
    void bridge.recording.get().then((r) => {
      setRecording(r.status);
      setRecorded(recordedOf(r));
      offer(r);
    });
    return bridge.recording.onChanged((r) => {
      offer(r);
      setRecorded(recordedOf(r));
      setRecording((before) => {
        if (before === "stopped" && r.status === "idle")
          void bridge.project?.get().then((p) => take(p));
        return r.status;
      });
    });
  }, [bridge, detached, take]);
  const startRecording = useCallback(() => {
    const target = recordTarget.current;
    void bridge.recording?.start(target ?? undefined);
  }, [bridge]);
  // A captured range (br-EXPORT-000003-sJpO9KMY): saved where the user chooses,
  // then added to the project, which shows it in the analysis view.
  const capture = useCallback(
    async (request: CaptureRequest) => {
      const r = await bridge.exports?.capture(request);
      if (!r) return;
      if (!r.ok) {
        if (!r.cancelled) void bridge.status.add(`metrics export failed: ${r.message}`);
        return;
      }
      void bridge.status.add(
        r.empty
          ? `metrics saved, but no data in the selected range: ${r.file}`
          : `metrics saved: ${r.file}`,
      );
      if (bridge.project) take(await bridge.project.addPaths([r.file]));
    },
    [bridge, take],
  );
  const pauseRecording = useCallback(() => void bridge.recording?.pause(), [bridge]);
  const stopRecording = useCallback(() => void bridge.recording?.stop(), [bridge]);

  /** Back to live tracking: the files stay open. */
  const backToLive = useCallback(() => {
    void bridge.analysis?.close();
    setProject((p) => (p ? { ...p, open: { ...p.open, active: null } } : p));
  }, [bridge]);
  /** A track's delay, set from its legend entry's menu. */
  const setDelay = useCallback(
    async (name: string, secs: number) => {
      const { item } = (await bridge.project?.tracks()) ?? { item: null };
      if (!item) return;
      take(
        await bridge.project?.change({ op: "setTrack", item, container: name, delaySecs: secs }),
      );
      setTracksVersion((v) => v + 1);
    },
    [bridge, take],
  );

  useEffect(() => {
    let live = true;
    void bridge.sidebar.get().then((l) => {
      if (live) setLayout(l);
    });
    const stop = bridge.sidebar.onLayout(setLayout);
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);

  // Close Data Streams: pause the window's active stream, its selection kept.
  const closeActive = useCallback(async () => {
    const id = await bridge.stream?.active();
    if (!id) return void bridge.status.add("No data stream to close");
    const r = await pauseStream(bridge.sump.request, id, true);
    void bridge.status.add(r.ok ? `Closed data stream ${id}; its selection is kept` : r.message);
    streamsChanged();
  }, [bridge, streamsChanged]);

  // The main window runs the actions; the detached one only asks for them.
  useEffect(() => {
    if (detached) return;
    return bridge.sidebar.onRun((name) => {
      if (name === "new-data-stream") setStreams("new");
      if (name === "edit-data-streams") setStreams("edit");
      if (name === "remove-data-stream") setRemoving(true);
      if (name === "create-event" || name === "edit-events") {
        void bridge.stream?.active().then(setActiveStream);
        if (name === "create-event") setEventForm({ editing: null });
        else setEventList(true);
      }
      if (name === "close-data-streams") void closeActive();
      if (name === "new-project") newProject();
      if (name === "open-project") openProject();
      if (name === "add-files") addFiles();
      if (name === "import-cttc") importCttc();
      if (name === "preferences") {
        void bridge.theme.get().then(setTheme);
        void bridge.status.visible().then(setStatusBar);
        void bridge.live?.get().then(setLive);
        setPreferences(true);
      }
    });
  }, [bridge, detached, closeActive, newProject, openProject, addFiles, importCttc]);

  /** Keep a live setting; the field shows what the main process kept. */
  const changeLive = useCallback(
    async (change: Partial<LiveSettings>) => {
      const r = await bridge.live?.set(change);
      if (r?.ok && r.settings) setLive(r.settings);
      else if (r?.message) void bridge.status.add(r.message);
    },
    [bridge],
  );

  const change = useCallback(
    (c: LayoutChange) => {
      setLayout((l) => (l ? applyChange(l, c) : l));
      void bridge.sidebar.set(c);
    },
    [bridge],
  );
  const action = useCallback((name: string) => void bridge.sidebar.action(name), [bridge]);
  // The File menu's project entries run here; the others in the main process.
  // Events (REQ-000046-sJpO9KMY): said in the status bar; firings refresh the list.
  const say = useCallback((text: string) => void bridge.status.add(text), [bridge]);
  useEffect(() => {
    if (detached || !bridge.events) return;
    return bridge.events.onFired(() => setEventsVersion((v) => v + 1));
  }, [bridge, detached]);
  /** A stale edit: the event as the Sump has it now, in the form again. */
  const reloadEvent = useCallback(
    async (event: SumpEvent) => {
      const r = await bridge.sump.request({ method: "GET", path: `/events/${event.id}` });
      setEventsVersion((v) => v + 1);
      if (r.ok) setEventForm({ editing: r.value as SumpEvent });
    },
    [bridge],
  );
  /** Download… a complete artifact into the project (cttc bug 26: checked first). */
  const downloadArtifact = useCallback(
    async (event: SumpEvent, artifact: Artifact) => {
      const r = await bridge.events?.download({
        artifact: artifact.id,
        name: event.name,
        size: artifact.size,
      });
      if (!r) return;
      if (!r.ok) {
        if (!r.cancelled) void bridge.status.add(`could not save event artifact: ${r.message}`);
        return;
      }
      void bridge.status.add(`event artifact saved: ${r.file}`);
      if (bridge.project) take(await bridge.project.addPaths([r.file]));
    },
    [bridge, take],
  );
  // The Appearance pane's colors, as the main process keeps them (REQ-000050-sJpO9KMY).
  useEffect(() => {
    if (!bridge.appearance) return;
    void bridge.appearance.get().then(setAppearance);
    return bridge.appearance.onChanged(setAppearance);
  }, [bridge]);
  // Ship Logs… (REQ-000049-sJpO9KMY): said in the status bar.
  const shipLogs = useCallback(async () => {
    const r = await bridge.logs?.ship?.();
    if (!r) return;
    if (!r.ok) {
      if (!r.cancelled) void bridge.status.add(`could not ship the logs: ${r.message}`);
      return;
    }
    const erased = r.erased ? `; ${r.erased} local files erased` : "";
    void bridge.status.add(`logs shipped: ${r.file} (${r.local} local files${erased})`);
  }, [bridge]);
  // Export Metrics… (REQ-000042-sJpO9KMY): only while a file is shown.
  const openExport = useCallback(() => {
    if (analysis) return setExportOpen(true);
    void bridge.status.add("Export Metrics needs a file shown in the analysis view");
  }, [analysis, bridge]);
  const exportMetrics = useCallback(
    async (choice: MetricsChoice) => {
      const r = await bridge.exports?.metrics(choice);
      if (!r) return false;
      if (r.ok) void bridge.status.add(`metrics exported: ${r.file}`);
      else if (!r.cancelled) void bridge.status.add(`metrics export failed: ${r.message}`);
      return r.ok;
    },
    [bridge],
  );
  const menuAction = useCallback(
    (name: string) => {
      if (name === "new-project") return newProject();
      if (name === "open-project") return openProject();
      if (name === "save-project") return saveProject();
      if (name === "save-project-as") return saveProjectAs();
      if (name === "add-files") return addFiles();
      if (name === "import-cttc") return importCttc();
      if (name === "start-recording") return startRecording();
      if (name === "pause-recording") return pauseRecording();
      if (name === "stop-recording") return stopRecording();
      if (name === "export-metrics") return openExport();
      if (name === "ship-logs") return void shipLogs();
      void bridge.menu.action(name);
    },
    [
      openExport,
      shipLogs,
      bridge,
      newProject,
      openProject,
      saveProject,
      saveProjectAs,
      addFiles,
      importCttc,
      startRecording,
      pauseRecording,
      stopRecording,
    ],
  );

  // Drag the splitter to resize, as cttc's (app.js:4512-4536).
  const drag = (event: ReactMouseEvent) => {
    if (!layout || layout.collapsed || layout.dock === "detached") return;
    event.preventDefault();
    const splitter = event.currentTarget;
    splitter.classList.add("dragging");
    const startX = event.clientX;
    const startWidth = layout.width;
    const sign = layout.dock === "right" ? -1 : 1;
    let width = startWidth;
    const move = (e: MouseEvent) => {
      width = Math.round(
        Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + sign * (e.clientX - startX))),
      );
      setLayout((l) => (l ? { ...l, width } : l));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      splitter.classList.remove("dragging");
      if (width !== startWidth) void bridge.sidebar.set({ width });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up, { once: true });
  };

  if (!layout) return null;
  const sidebar = (
    <Sidebar
      layout={layout}
      detached={detached}
      onChange={change}
      onAction={action}
      projectTree={
        project && !detached ? (
          <ProjectTree
            project={{
              name: project.session.name,
              dirty: project.session.dirty,
              isDefault: project.session.isDefault,
              folders: project.session.project.folders,
              items: project.session.project.items,
              sump: project.session.project.sump,
              missing: project.session.missing,
            }}
            open={project.open}
            recent={project.recent}
            onShow={showFile}
            onChange={changeProject}
            onAddFiles={addFiles}
            onSave={saveProject}
            onSaveAs={saveProjectAs}
            onOpenRecent={openRecent}
            onBind={() => void bind()}
          />
        ) : undefined
      }
    />
  );
  if (detached) return sidebar;
  return (
    <>
      <MenuBar onAction={menuAction} />
      <div id="app-body" data-dock={layout.dock}>
        {sidebar}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: cttc's splitter; the sidebar keeps its size without it. */}
        <div id="action-bar-splitter" title="Drag to resize the sidebar" onMouseDown={drag} />
        <div id="main-content">
          <ChartBlock
            key={analysis ? `file:${analysis.path}:${shown}` : "live"}
            bridge={fileBridge ?? bridge}
            version={streamsVersion + tracksVersion}
            transport={(target) => {
              recordTarget.current = target;
              return (
                <Transport
                  status={recording}
                  onStart={startRecording}
                  onPause={pauseRecording}
                  onStop={stopRecording}
                />
              );
            }}
            recorded={recorded}
            onCapture={capture}
            onCaptureMode={setCaptureArmed}
            onLegendMenu={analysis ? (name, x, y) => setTrackMenu({ name, x, y }) : undefined}
            analysis={analysis}
            onBackToLive={backToLive}
            onExportMetrics={analysis ? openExport : undefined}
            initialView={analysis ? null : liveView.current}
            onViewState={analysis ? undefined : keepLiveView}
            onLiveStatus={setLiveStatus}
            hostOpen={logs.hostOpen}
            onHostToggle={logs.setHostOpen}
            lanes={(shown) => (
              <Lanes
                request={(fileBridge ?? bridge).sump.request}
                stream={shown.stream.id}
                containers={shown.containers}
                slots={shown.slots}
                view={shown.view}
                open={logs.lanesOpen}
                onToggle={logs.setLanesOpen}
                shownView={shown.shownView}
                nowT={shown.nowT}
                bands={
                  analysis
                    ? undefined
                    : bandsAt(recorded, shown.stream.id, shown.nowT ?? Date.now())
                }
                cursorT={shown.cursorT}
                cursorLive={shown.cursorLive}
                onCursor={shown.setCursor}
                onRecenter={shown.recenterAt}
                onZoom={shown.zoomTo}
                captureArmed={shown.captureArmed}
                onCapture={shown.capture}
                onTimeMenu={shown.timeMenu}
              />
            )}
            panels={(shown) => (
              <Panels
                bridge={fileBridge ?? bridge}
                shown={shown}
                order={logs.order}
                onOrder={logs.setOrder}
              />
            )}
          />
        </div>
        <PreferencesDialog
          open={preferences}
          onClose={() => setPreferences(false)}
          bridge={bridge}
          theme={theme}
          onTheme={(mode) => {
            setTheme(mode);
            void bridge.theme.set(mode);
          }}
          statusBar={statusBar}
          onStatusBar={(visible) => {
            setStatusBar(visible);
            void bridge.status.setVisible(visible);
          }}
          live={live}
          onLive={(c) => void changeLive(c)}
          onShipLogs={() => void shipLogs()}
          say={say}
        />
      </div>
      <StreamsDialog
        bridge={bridge}
        mode={streams}
        onClose={() => {
          setStreams(null);
          streamsChanged();
        }}
      />
      {trackMenu ? (
        <ContextMenu
          x={trackMenu.x}
          y={trackMenu.y}
          label={`Track ${trackMenu.name}`}
          onClose={() => setTrackMenu(null)}
          entries={[
            {
              label: "Delay…",
              title: "Shift this track's data, to line up captures from clocks that differ",
              onSelect: () => {
                const name = trackMenu.name;
                void bridge.project
                  ?.tracks()
                  .then(({ tracks }) => setDelaying({ name, secs: tracks[name]?.delaySecs ?? 0 }));
              },
            },
          ]}
        />
      ) : null}
      <ExportMetricsDialog
        open={exportOpen}
        onExport={exportMetrics}
        onClose={() => setExportOpen(false)}
      />
      <RecoveryDialog
        open={interrupted !== null}
        sumpGone={interrupted?.sumpGone ?? false}
        onInterruption={() => {
          setInterrupted(null);
          void bridge.recording?.resume("interruption");
        }}
        onNow={() => {
          setInterrupted(null);
          void bridge.recording?.resume("now");
        }}
        onLater={() => setInterrupted(null)}
      />
      <DelayDialog
        delaying={delaying}
        onClose={() => setDelaying(null)}
        onSet={(name, secs) => void setDelay(name, secs)}
      />
      <Dialog
        id="dlg-project-unsaved"
        open={asking !== null}
        onClose={() => setAsking(null)}
        title="Save the project?"
        actions={
          <>
            <Button onClick={() => setAsking(null)}>Cancel</Button>
            <Button
              kind="danger"
              onClick={() => {
                const then = asking;
                setAsking(null);
                then?.();
              }}
            >
              Discard
            </Button>
            <Button
              kind="primary"
              onClick={async () => {
                const then = asking;
                setAsking(null);
                const r = await bridge.project?.save();
                take(r);
                if (r?.ok) then?.();
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <p className="dlg-intro">
          {project?.session.name} has changes not saved. Discarded changes are lost.
        </p>
      </Dialog>
      <Dialog
        id="dlg-project-sump"
        open={offer !== null}
        onClose={() => setOffer(null)}
        title="Switch to the project's Sump?"
        actions={
          <>
            <Button onClick={() => setOffer(null)}>Stay</Button>
            <Button kind="primary" onClick={() => void switchToBound()}>
              Switch
            </Button>
          </>
        }
      >
        <p className="dlg-intro">
          This project is bound to the Sump {offer?.sump} and its data stream {offer?.stream}.
          Switching moves this window to them.
        </p>
      </Dialog>
      <EventFormDialog
        open={eventForm !== null}
        editing={eventForm?.editing ?? null}
        request={bridge.sump.request}
        activeStream={activeStream}
        say={say}
        onSaved={() => setEventsVersion((v) => v + 1)}
        onStale={reloadEvent}
        onClose={() => setEventForm(null)}
      />
      <EventListDialog
        open={eventList}
        request={bridge.sump.request}
        version={eventsVersion}
        say={say}
        onEdit={(event) => setEventForm({ editing: event })}
        onDownload={downloadArtifact}
        onClose={() => setEventList(false)}
      />
      <RemoveDialog
        bridge={bridge}
        open={removing}
        onClose={() => setRemoving(false)}
        onRemoved={streamsChanged}
      />
      <PromoteDialog
        bridge={bridge}
        open={promoting}
        onClose={() => setPromoting(false)}
        onPromoted={streamsChanged}
      />
      <StatusBar
        bridge={bridge}
        onStreamAction={(name) =>
          // Promote… is the pill's own (cttc's sidebar has no such entry).
          name === "promote-data-stream" ? setPromoting(true) : action(name)
        }
        streamsVersion={streamsVersion}
        persistent={captureArmed ? "capture mode ✂️" : liveStatus}
        blink={captureArmed}
        mode={analysis ? "analysis" : "live"}
        recording={recording}
        onBackToLive={backToLive}
      />
    </>
  );
}
