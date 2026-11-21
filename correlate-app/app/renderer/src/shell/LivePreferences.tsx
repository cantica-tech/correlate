/**
 * The live view's settings in Preferences (REQ-000031-sJpO9KMY Requirement 4),
 * cttc's Settings pane (`index.html:531-556`): the Time window, Live tracking
 * and its offset, and the double-click resume delay. The main process clamps
 * each to `br-VIEW-000002-sJpO9KMY`'s limits; the fields show what it kept.
 */
import { Switch } from "../components/index.js";
import type { LiveSettings } from "./bridge.js";

/**
 * A whole number of seconds, kept when it changes (cttc's `change`: on Enter or
 * leaving the field); the main process clamps it, and the field shows what was
 * kept.
 */
function SecondsField(props: {
  id: string;
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  label: string;
  onCommit: (value: number) => void;
}) {
  const commit = (input: HTMLInputElement) => {
    const n = Number(input.value);
    if (input.value.trim() === "" || !Number.isFinite(n)) input.value = String(props.value);
    else if (n !== props.value) props.onCommit(n);
  };
  return (
    <label className="ctl">
      <input
        key={props.value}
        id={props.id}
        type="number"
        step={1}
        min={props.min}
        max={props.max}
        disabled={props.disabled}
        aria-label={props.label}
        defaultValue={props.value}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget);
        }}
      />{" "}
      s
    </label>
  );
}

/** The live settings' props. */
export interface LivePreferencesProps {
  live: LiveSettings;
  onChange: (change: Partial<LiveSettings>) => void;
}

/** The live settings' fieldsets. */
export function LivePreferences({ live, onChange }: LivePreferencesProps) {
  return (
    <>
      <fieldset className="keys-box">
        <legend>Time window</legend>
        <p className="dlg-section-help muted">
          Size of the ± highlight window around the selected time -- not a data-polling rate (the
          charts are read every 5 s on their own).
        </p>
        <SecondsField
          id="win-secs"
          label="Time window, in seconds"
          value={live.windowSecs}
          min={1}
          onCommit={(windowSecs) => onChange({ windowSecs })}
        />
      </fieldset>
      <fieldset className="keys-box">
        <legend>Live tracking</legend>
        <p className="dlg-section-help muted">
          While following live, automatically moves the cursor to now + this many seconds on every
          refresh -- 0 tracks exactly now, negative looks slightly into the past (never positive:
          the future has no data to show yet).
        </p>
        <div className="ctl block live-track-enable-row">
          <Switch
            id="live-track-toggle"
            checked={live.liveTrack}
            onChange={(liveTrack) => onChange({ liveTrack })}
          >
            Enable Live tracking
          </Switch>
          <SecondsField
            id="live-track-secs"
            label="Live tracking offset, in seconds"
            value={live.liveTrackSecs}
            max={0}
            disabled={!live.liveTrack}
            onCommit={(liveTrackSecs) => onChange({ liveTrackSecs })}
          />
        </div>
        <p className="dlg-section-help muted">
          Double-clicking the chart recenters it on that point in time, which pauses live tracking
          (like any other pan/zoom). This many seconds later, live tracking resumes on its own. Set
          to 0 to stay paused until you click "now" yourself.
        </p>
        <SecondsField
          id="dblclick-resume-secs"
          label="Resume live tracking after, in seconds"
          value={live.resumeSecs}
          min={0}
          onCommit={(resumeSecs) => onChange({ resumeSecs })}
        />
      </fieldset>
    </>
  );
}
