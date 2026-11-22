/**
 * What a recording has captured, as bands on the charts and the density lanes
 * (cttc's `drawHighlightBands`, `app.js:723`, ui-REC-004; REQ-000040-sJpO9KMY):
 * while it is in progress or paused, one band per completed segment and, while
 * recording, one growing to now; never one across a pause's gap. Only on the
 * live view of the recording's own data stream.
 */
import type { RecordingState } from "../shell/bridge.js";

/** cttc's default band color (`DEFAULT_RECORDING_COLOR`); its control comes with Item 52. */
export const RECORDING_BAND_COLOR = "#fab219";

/** The ranges a recording holds, and where its current segment started. */
export interface Recorded {
  /** The recording's data stream. */
  stream: string;
  segments: readonly { from: number; to: number }[];
  /** While recording: the current segment's start. */
  liveFrom: number | null;
}

/** What to band, from the session's state: nothing when idle or stopped. */
export function recordedOf(state: RecordingState | null | undefined): Recorded | null {
  if (!state || !state.target) return null;
  if (state.status !== "recording" && state.status !== "paused") return null;
  return {
    stream: state.target.stream,
    segments: state.segments,
    liveFrom: state.status === "recording" ? state.segmentStart : null,
  };
}

/** No band: one shared empty list, so the canvases are not redrawn for nothing. */
const NONE: readonly { t0: number; t1: number }[] = [];

/** The bands on stream `stream`'s live view at time `now`. */
export function bandsAt(
  recorded: Recorded | null | undefined,
  stream: string | null | undefined,
  now: number,
): readonly { t0: number; t1: number }[] {
  if (!recorded || recorded.stream !== stream) return NONE;
  const bands = recorded.segments.map((s) => ({ t0: s.from, t1: s.to }));
  if (recorded.liveFrom !== null && now > recorded.liveFrom)
    bands.push({ t0: recorded.liveFrom, t1: now });
  return bands;
}
