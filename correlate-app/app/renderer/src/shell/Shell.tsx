/**
 * The app's shell (REQ-000021-sJpO9KMY): cttc's `#app-body`, the sidebar on
 * the side it docks to, its splitter, and the main content beside it; or, in
 * the detached window, the sidebar alone. The layout comes from the main
 * process and every change goes back to it, so both windows show the same.
 */
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useState } from "react";
import { ChartBlock } from "../charts/ChartBlock.js";
import { Button, Dialog, SegControl, Switch } from "../components/index.js";
import { MenuBar } from "../menubar/MenuBar.js";
import { StatusBar } from "../statusbar/StatusBar.js";
import { pauseStream } from "../streams/api.js";
import { RemoveDialog } from "../streams/RemoveDialog.js";
import { StreamsDialog } from "../streams/StreamsDialog.js";
import type { LayoutChange, ShellBridge, SidebarLayout, ThemeMode } from "./bridge.js";
import { Sidebar } from "./Sidebar.js";

/** The splitter's bounds, as the main process checks them. */
const MIN_WIDTH = 120;
const MAX_WIDTH = 480;

const THEMES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

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

/** The shell. */
export function Shell({ bridge, detached = false }: ShellProps) {
  const [layout, setLayout] = useState<SidebarLayout | null>(null);
  const [preferences, setPreferences] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [statusBar, setStatusBar] = useState(true);
  const [streams, setStreams] = useState<"new" | "edit" | null>(null);
  const [removing, setRemoving] = useState(false);
  const [streamsVersion, setStreamsVersion] = useState(0);
  const streamsChanged = useCallback(() => setStreamsVersion((v) => v + 1), []);

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
      if (name === "close-data-streams") void closeActive();
      if (name === "preferences") {
        void bridge.theme.get().then(setTheme);
        void bridge.status.visible().then(setStatusBar);
        setPreferences(true);
      }
    });
  }, [bridge, detached, closeActive]);

  const change = useCallback(
    (c: LayoutChange) => {
      setLayout((l) => (l ? applyChange(l, c) : l));
      void bridge.sidebar.set(c);
    },
    [bridge],
  );
  const action = useCallback((name: string) => void bridge.sidebar.action(name), [bridge]);
  const menuAction = useCallback((name: string) => void bridge.menu.action(name), [bridge]);

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
    <Sidebar layout={layout} detached={detached} onChange={change} onAction={action} />
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
          <ChartBlock bridge={bridge} version={streamsVersion} />
        </div>
        <Dialog
          id="dlg-preferences-theme"
          open={preferences}
          onClose={() => setPreferences(false)}
          title="Preferences"
          actions={
            <Button kind="primary" onClick={() => setPreferences(false)}>
              Done
            </Button>
          }
        >
          <fieldset className="keys-box">
            <legend>Mode</legend>
            <p className="dlg-section-help muted">
              Light, dark, or match this computer's system setting.
            </p>
            <SegControl
              label="Mode"
              options={THEMES}
              value={theme}
              onChange={(mode) => {
                setTheme(mode);
                void bridge.theme.set(mode);
              }}
            />
          </fieldset>
          <fieldset className="keys-box">
            <legend>Status bar</legend>
            <p className="dlg-section-help muted">
              A slim bar at the bottom of the window: the Sump's status, messages and their History.
            </p>
            <Switch
              checked={statusBar}
              onChange={(visible) => {
                setStatusBar(visible);
                void bridge.status.setVisible(visible);
              }}
            >
              Show status bar
            </Switch>
          </fieldset>
        </Dialog>
      </div>
      <StreamsDialog
        bridge={bridge}
        mode={streams}
        onClose={() => {
          setStreams(null);
          streamsChanged();
        }}
      />
      <RemoveDialog
        bridge={bridge}
        open={removing}
        onClose={() => setRemoving(false)}
        onRemoved={streamsChanged}
      />
      <StatusBar bridge={bridge} onStreamAction={action} streamsVersion={streamsVersion} />
    </>
  );
}
