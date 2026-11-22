/**
 * Regression corpus of cttc's bugs: analysis view (ANLYS).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus.
 */
import { describe, expect, it } from "vitest";
import {
  bounded,
  fileState,
  goLive,
  moved,
  recentred,
} from "../../../renderer/src/charts/viewState.js";

describe("br-ANLYS-000001-sJpO9KMY", () => {
  // BUG-000014-uKKrzikI, High: becomes a real test with roadmap Item 43
  // (RM-000044-sJpO9KMY).
  it.todo("cttc BUG-000014: Snapshots mix live and loaded-file telemetry");
});

describe("br-ANLYS-000002-sJpO9KMY", () => {
  // BUG-000016-uKKrzikI, Medium: built with roadmap Item 34 (RM-000035-sJpO9KMY).
  it("cttc BUG-000016: 'now' label moves the analysis view to the present", () => {
    // cttc's "now" called goLive whatever the view showed, so a loaded file's
    // view jumped to the present. A file's view is never live, its navigator
    // shows no "now" (TimelineNav's showNow), the chart block ignores one
    // (nowLive returns in analysis), and every view is kept within the file.
    const file = { from: Date.UTC(2026, 7, 6, 12, 0), to: Date.UTC(2026, 7, 6, 12, 4) };
    const opened = fileState(file);
    expect(opened).toEqual({ view: { t0: file.from, t1: file.to }, live: false, resumeAt: null });
    // Even what live would do lands back inside the file.
    const jumped = goLive(opened, Date.UTC(2026, 10, 22, 9, 0));
    expect(bounded(jumped.view, file).t1).toBeLessThanOrEqual(file.to);
    expect(bounded(jumped.view, file).t0).toBeGreaterThanOrEqual(file.from);
    // A recentre in a file never pauses toward a resume to live.
    expect(recentred(opened, file.from + 60_000, Date.now(), 10).resumeAt).toBeNull();
    expect(moved({ t0: file.from, t1: file.from + 100 })).toBeNull();
  });
});

describe("br-ANLYS-000004-sJpO9KMY", () => {
  // BUG-000017-uKKrzikI, Medium: becomes a real test with roadmap Item 35
  // (RM-000036-sJpO9KMY).
  it.todo("cttc BUG-000017: Multi-file load centres on the union, not the active file");
  // BUG-000018-uKKrzikI, Low: becomes a real test with roadmap Item 35
  // (RM-000036-sJpO9KMY).
  it.todo("cttc BUG-000018: Re-opening or switching files does not use the 75% framing");
});

describe("br-ANLYS-000005-sJpO9KMY", () => {
  // BUG-000019-uKKrzikI, Medium: becomes a real test with roadmap Item 35
  // (RM-000036-sJpO9KMY).
  it.todo("cttc BUG-000019: Open-file dedup keys on basename only");
});
