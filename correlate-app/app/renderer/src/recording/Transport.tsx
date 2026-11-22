/**
 * cttc's recording transport (`index.html:183-187`, `syncRecordingMenu`
 * `app.js:3316`; REQ-000037-sJpO9KMY Requirement 5): ⏺ (Start, or Resume
 * when paused; its dot red and blinking while recording, orange while stopped
 * and not yet saved), ⏸ (blinking orange while paused), ⏹; each enabled as
 * cttc's.
 */
import type { RecordingState } from "../shell/bridge.js";

/** The transport's props. */
export interface TransportProps {
  status: RecordingState["status"];
  onStart: () => void;
  onPause: () => void;
  onStop: () => void;
}

/** The transport. */
export function Transport({ status, onStart, onPause, onStop }: TransportProps) {
  return (
    <span className="btn-group" id="recording-transport">
      <button
        type="button"
        id="btn-start-recording"
        data-state={status}
        disabled={status === "recording" || status === "stopped"}
        title={
          status === "recording"
            ? "Recording"
            : status === "paused"
              ? "Resume Recording"
              : "Start Recording"
        }
        onClick={onStart}
      >
        <span id="recording-glyph">⏺</span>
        <span id="recording-dot" className="recording-dot" />
      </button>
      <button
        type="button"
        id="btn-pause-recording"
        data-state={status}
        disabled={status !== "recording"}
        title={status === "paused" ? "Recording Paused" : "Pause Recording"}
        onClick={onPause}
      >
        <span id="pause-glyph">⏸</span>
      </button>
      <button
        type="button"
        id="btn-stop-recording"
        disabled={status === "idle"}
        title="Stop Recording"
        onClick={onStop}
      >
        ⏹
      </button>
    </span>
  );
}

/** cttc's status bar recording text for a state. */
export function recordingText(status: RecordingState["status"]): string {
  return status === "paused"
    ? "recording paused"
    : status === "recording"
      ? "recording"
      : status === "stopped"
        ? "recording stopped, not yet saved"
        : "";
}
