/**
 * cttc's Preferences dialog (`#dlg-preferences`, `index.html:518-660`, styled
 * as macOS System Settings; REQ-000050-sJpO9KMY): one dialog, two panes, in
 * place of the app's separate theme and live-settings dialogs.
 *
 * It always opens on Settings (br-PREF-000001-sJpO9KMY). Settings' fields
 * apply at once: the time window and live tracking (`LivePreferences`), the
 * own log (turning it on asks for a folder, br-DIAG-000001-sJpO9KMY) and
 * Ship Logs, the status bar's message time, and Hard Reset (the system asks;
 * preferences only). Appearance previews its colors and styles as they are
 * picked; Save keeps them, Cancel (or closing) puts them back, Reset picks
 * cttc's defaults.
 */
import { useEffect, useRef, useState } from "react";
import { Dialog, SegControl, Switch } from "../components/index.js";
import { Icon } from "../icons/Icon.js";
import { APPEARANCE_DEFAULTS, appearance, setAppearance } from "../theme/appearance.js";
import type { Appearance, LiveSettings, OwnLogState, ShellBridge, ThemeMode } from "./bridge.js";
import { LivePreferences } from "./LivePreferences.js";

/** The panes, as cttc's ids. */
type Pane = "pane-settings" | "pane-preferences";

const THEMES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

const NOW_STYLES = [
  { value: "dotted", label: "Dotted" },
  { value: "dashed", label: "Dashed" },
  { value: "solid", label: "Solid" },
] as const;

/** The dialog's props. */
export interface PreferencesDialogProps {
  open: boolean;
  onClose: () => void;
  bridge: Pick<ShellBridge, "appearance" | "preferences" | "logs">;
  theme: ThemeMode;
  onTheme: (mode: ThemeMode) => void;
  statusBar: boolean;
  onStatusBar: (visible: boolean) => void;
  live: LiveSettings | null;
  onLive: (change: Partial<LiveSettings>) => void;
  /** Ship Logs (Item 51), from the own log's row. */
  onShipLogs: () => void;
  /** Said in the status bar. */
  say: (text: string) => void;
}

/** The own log's row's words: where it writes, or that it is off. */
export function ownLogText(state: OwnLogState | null): string {
  if (!state) return "";
  return state.enabled && state.dir ? `Folder: ${state.dir}` : "Off";
}

/** The dialog. */
export function PreferencesDialog(props: PreferencesDialogProps) {
  const { open, onClose, bridge, theme, onTheme, statusBar, onStatusBar, live, onLive } = props;
  const [pane, setPane] = useState<Pane>("pane-settings");
  const [ownLog, setOwnLog] = useState<OwnLogState | null>(null);
  const [draft, setDraft] = useState<Appearance>(appearance());
  /** The appearance as saved: Cancel puts it back. */
  const saved = useRef<Appearance>(appearance());

  // Each opening lands on Settings (br-PREF-000001), the appearance as saved.
  useEffect(() => {
    if (!open) return;
    setPane("pane-settings");
    saved.current = appearance();
    setDraft(appearance());
    void bridge.preferences?.ownLog().then(setOwnLog);
  }, [open, bridge]);

  /** Preview a change to the appearance. */
  const preview = (change: Partial<Appearance>) => {
    const next = { ...draft, ...change };
    setDraft(next);
    setAppearance(next);
  };
  /** Close, the unsaved appearance put back. */
  const close = () => {
    setAppearance(saved.current);
    onClose();
  };
  const save = async () => {
    const { statusClearSecs: _kept, ...colors } = draft;
    const r = await bridge.appearance?.set(colors);
    if (r && !r.ok) return props.say(`could not save the appearance: ${r.message}`);
    saved.current = draft;
    onClose();
  };

  return (
    <Dialog id="dlg-preferences" open={open} onClose={close} title={null}>
      <div className="mac-settings">
        <nav className="mac-settings-sidebar">
          <span className="mac-settings-sidebar-label">
            <Icon name="preferences-window" />
            Preferences
          </span>
          <button
            type="button"
            className="mac-settings-search"
            title="Search (coming soon)"
            disabled
          >
            <Icon name="search" />
          </button>
          {(
            [
              ["pane-settings", "settings", "Settings"],
              ["pane-preferences", "appearance", "Appearance"],
            ] as const
          ).map(([id, icon, label]) => (
            <button
              key={id}
              type="button"
              className="mac-settings-item"
              data-pane={id}
              data-active={pane === id ? "true" : undefined}
              onClick={() => setPane(id)}
            >
              <span className="mac-settings-item-icon">
                <Icon name={icon} />
              </span>
              {label}
            </button>
          ))}
        </nav>
        <div className="mac-settings-content">
          <div id="pane-settings" className="mac-settings-pane" hidden={pane !== "pane-settings"}>
            <h2 className="mac-settings-pane-title">
              <Icon name="settings" />
              Settings
            </h2>
            {live ? <LivePreferences live={live} onChange={onLive} /> : null}
            <fieldset className="keys-box" id="fieldset-log-collector">
              <legend>Collect correlate-app's Own Logs</legend>
              <p className="dlg-section-help muted">
                Write correlate-app's own diagnostic log messages to timestamped .log files in a
                folder you choose.
              </p>
              <div className="ctl log-collect-row">
                <label className="ctl switch-row">
                  <span className="switch">
                    <input
                      id="log-collect-toggle"
                      type="checkbox"
                      checked={ownLog?.enabled ?? false}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        void bridge.preferences?.setOwnLog(on).then(setOwnLog);
                      }}
                    />
                    <span className="switch-track">
                      <span className="switch-thumb" />
                    </span>
                  </span>
                  <span id="log-collect-status" className="muted">
                    {ownLogText(ownLog)}
                  </span>
                </label>
                <button
                  id="btn-ship-logs"
                  className="icon-btn"
                  type="button"
                  title="Ship logs"
                  onClick={props.onShipLogs}
                >
                  <Icon name="ship-logs" />
                </button>
              </div>
            </fieldset>
            <fieldset className="keys-box">
              <legend>Status Bar</legend>
              <p className="dlg-section-help muted">
                Non-persistent status bar messages (event notifications, action confirmations) clear
                automatically after this many seconds. Ongoing/ticking statuses (e.g. a
                live-tracking countdown) are unaffected.
              </p>
              <label className="ctl">
                <input
                  id="status-bar-clear-secs-sidebar"
                  type="number"
                  min="1"
                  step="1"
                  value={draft.statusClearSecs}
                  onChange={(e) => {
                    const secs = Number(e.currentTarget.value);
                    if (!Number.isFinite(secs) || secs < 1) return;
                    const next = { ...appearance(), statusClearSecs: secs };
                    setDraft((d) => ({ ...d, statusClearSecs: secs }));
                    saved.current = { ...saved.current, statusClearSecs: secs };
                    setAppearance(next);
                    void bridge.appearance?.set({ statusClearSecs: secs });
                  }}
                />{" "}
                s
              </label>
            </fieldset>
            <fieldset className="keys-box danger-zone">
              <legend>Danger</legend>
              <p className="dlg-section-help muted">
                Remove all saved preferences and reset the application (this cannot be undone!)
              </p>
              <button
                id="btn-hard-reset"
                type="button"
                className="btn-danger"
                onClick={() => void bridge.preferences?.hardReset()}
              >
                Hard Reset
              </button>
            </fieldset>
            <div className="dlg-actions">
              <button
                id="dlg-settings-close"
                type="button"
                className="primary"
                title="Close"
                onClick={close}
              >
                Close
              </button>
            </div>
          </div>
          <div
            id="pane-preferences"
            className="mac-settings-pane"
            hidden={pane !== "pane-preferences"}
          >
            <h2 className="mac-settings-pane-title">
              <Icon name="appearance" />
              Appearance
            </h2>
            <fieldset className="keys-box">
              <legend>Mode</legend>
              <p className="dlg-section-help muted">
                Light, dark, or match this computer's system setting.
              </p>
              <SegControl
                label="Mode"
                id="theme-mode-switch"
                options={THEMES}
                value={theme}
                onChange={onTheme}
              />
            </fieldset>
            <fieldset className="keys-box">
              <legend>Log highlight color</legend>
              <p className="dlg-section-help muted">
                Color used to highlight log entries within the poll interval window around the
                selected time.
              </p>
              <label className="ctl block">
                <input
                  id="theme-hl-color"
                  type="color"
                  value={draft.hlColor}
                  onChange={(e) => preview({ hlColor: e.currentTarget.value })}
                />
              </label>
            </fieldset>
            <fieldset className="keys-box">
              <legend>"Now" line</legend>
              <p className="dlg-section-help muted">
                The dotted line marking the actual current time as it progresses across the graphs.
              </p>
              <label className="ctl block">
                <input
                  id="theme-now-color"
                  type="color"
                  value={draft.nowColor}
                  onChange={(e) => preview({ nowColor: e.currentTarget.value })}
                />
              </label>
              <SegControl
                label='"Now" line style'
                id="theme-now-style-switch"
                options={NOW_STYLES}
                value={draft.nowStyle}
                onChange={(nowStyle) => preview({ nowStyle })}
              />
            </fieldset>
            <fieldset className="keys-box">
              <legend>Live tracking</legend>
              <p className="dlg-section-help muted">
                The bar marking where Live tracking has moved the cursor to, and the matching
                highlight on log entries around it.
              </p>
              <label className="ctl block">
                <input
                  id="theme-live-track-color"
                  type="color"
                  value={draft.liveTrackColor}
                  onChange={(e) => preview({ liveTrackColor: e.currentTarget.value })}
                />
              </label>
            </fieldset>
            <fieldset className="keys-box">
              <legend>Recording capture</legend>
              <p className="dlg-section-help muted">
                The band marking time ranges a recording has already captured, on the charts and
                density lanes.
              </p>
              <label className="ctl block">
                <input
                  id="theme-recording-color"
                  type="color"
                  value={draft.recordingColor}
                  onChange={(e) => preview({ recordingColor: e.currentTarget.value })}
                />
              </label>
              <Switch
                id="theme-recording-sprockets-toggle"
                checked={draft.sprockets}
                onChange={(sprockets) => preview({ sprockets })}
              >
                Sprocket holes
              </Switch>
            </fieldset>
            <fieldset className="keys-box">
              <legend>Status bar</legend>
              <p className="dlg-section-help muted">
                A slim bar at the bottom of the window reporting when an event is created or fires.
              </p>
              <Switch id="theme-status-bar-toggle" checked={statusBar} onChange={onStatusBar}>
                Show status bar
              </Switch>
            </fieldset>
            <div className="dlg-actions">
              <button
                id="dlg-theme-reset"
                type="button"
                title="Reset to the default colors"
                onClick={() =>
                  preview({ ...APPEARANCE_DEFAULTS, statusClearSecs: draft.statusClearSecs })
                }
              >
                Reset
              </button>
              <button
                id="dlg-theme-close"
                type="button"
                title="Close without saving changes"
                onClick={close}
              >
                Cancel
              </button>
              <button
                id="dlg-theme-save"
                type="button"
                className="primary"
                title="Save these colors"
                onClick={() => void save()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
