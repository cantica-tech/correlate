/**
 * What a recording has captured, as bands (REQ-000040-sJpO9KMY, cttc's
 * `drawHighlightBands`): one per segment, one growing while recording, none
 * across a pause's gap, only on the recording's own stream.
 */
import { describe, expect, it } from "vitest";
import type { RecordingState } from "../../shell/bridge.js";
import { bandsAt, recordedOf } from "../bands.js";

const target = { sump: "local", stream: "self", containers: ["web"], host: false };
const state = (over: Partial<RecordingState>): RecordingState => ({
  status: "idle",
  target: null,
  segments: [],
  segmentStart: null,
  ...over,
});

describe("br-REC-000002-sJpO9KMY: the recording's bands", () => {
  it("bands each segment, and the current one up to now while recording", () => {
    const recorded = recordedOf(
      state({ status: "recording", target, segments: [{ from: 0, to: 10 }], segmentStart: 30 }),
    );
    expect(bandsAt(recorded, "self", 45)).toEqual([
      { t0: 0, t1: 10 },
      { t0: 30, t1: 45 },
    ]);
  });

  it("bands only the completed segments while paused, never the pause's gap", () => {
    const recorded = recordedOf(
      state({
        status: "paused",
        target,
        segments: [
          { from: 0, to: 10 },
          { from: 30, to: 45 },
        ],
      }),
    );
    expect(bandsAt(recorded, "self", 100)).toEqual([
      { t0: 0, t1: 10 },
      { t0: 30, t1: 45 },
    ]);
  });

  it("bands nothing when idle or stopped, or on another stream", () => {
    expect(recordedOf(state({}))).toBeNull();
    expect(recordedOf(state({ status: "stopped", target }))).toBeNull();
    const recorded = recordedOf(state({ status: "recording", target, segmentStart: 0 }));
    expect(bandsAt(recorded, "ssh:ops@lab:22", 10)).toEqual([]);
    expect(bandsAt(null, "self", 10)).toBe(bandsAt(undefined, "self", 20));
  });
});
