import path from "node:path";
/**
 * Regression corpus of cttc's bugs: analysis view (ANLYS).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus.
 */
import { describe, expect, it } from "vitest";
import { OpenFiles, openFiles } from "../../../main/src/analysis/ipc.js";
import { zip } from "../../../main/src/analysis/tests/zipWriter.js";
import {
  bounded,
  fileState,
  frameOf,
  goLive,
  moved,
  recentred,
} from "../../../renderer/src/charts/viewState.js";

/** A path as the OS resolves it (a drive and backslashes on Windows). */
const resolved = (p: string) => path.resolve(p);

/** A cttc archive of one container's log over `[from, to]`. */
function archiveOver(from: number, to: number): Buffer {
  return zip({
    "manifest.json": JSON.stringify({
      version: 3,
      segments: [{ from, to, sources: [{ type: "log", name: "web", file: "seg0/logs/0.jsonl" }] }],
    }),
    "seg0/logs/0.jsonl": JSON.stringify({ ts: from + 1, text: "hello" }),
  });
}

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
    const frame = frameOf(file);
    expect(opened).toEqual({ view: { t0: frame.from, t1: frame.to }, live: false, resumeAt: null });
    // Even what live would do lands back inside the file.
    const jumped = goLive(opened, Date.UTC(2026, 10, 22, 9, 0));
    expect(bounded(jumped.view, frame).t1).toBeLessThanOrEqual(frame.to);
    expect(bounded(jumped.view, frame).t0).toBeGreaterThanOrEqual(frame.from);
    // A recentre in a file never pauses toward a resume to live.
    expect(recentred(opened, file.from + 60_000, Date.now(), 10).resumeAt).toBeNull();
    expect(moved({ t0: file.from, t1: file.from + 100 })).toBeNull();
  });
});

describe("br-ANLYS-000004-sJpO9KMY", () => {
  const event = { sender: { id: 1 } };
  const first = { from: Date.UTC(2026, 7, 6, 12, 0), to: Date.UTC(2026, 7, 6, 12, 10) };
  const second = { from: Date.UTC(2026, 7, 7, 9, 0), to: Date.UTC(2026, 7, 7, 9, 2) };
  const deps = (chosen: string[]) => ({
    ask: async () => chosen,
    size: async () => 100,
    read: async (f: string) =>
      f.includes("first") ? archiveOver(first.from, first.to) : archiveOver(second.from, second.to),
  });

  // BUG-000017-uKKrzikI, Medium: built with roadmap Item 35 (RM-000036-sJpO9KMY).
  it("cttc BUG-000017: Multi-file load centres on the union, not the active file", async () => {
    // cttc framed the union of every opened file's range: two files a day
    // apart showed a day-wide view of nothing. The active file alone is framed.
    const r = await openFiles(
      event,
      new OpenFiles(),
      deps([resolved("/x/first.cttc-record"), resolved("/x/second.cttc-record")]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const active = r.files.find((f) => f.path === r.active);
    expect(active).toMatchObject(second);
    const view = fileState(active as typeof second).view;
    expect(view).toEqual({ t0: second.from - 20_000, t1: second.to + 20_000 });
  });

  // BUG-000018-uKKrzikI, Low: built with roadmap Item 35 (RM-000036-sJpO9KMY).
  it("cttc BUG-000018: Re-opening or switching files does not use the 75% framing", async () => {
    // cttc framed only on the first load; re-opening or switching kept the
    // previous, often out-of-range view. Each open and switch frames the file
    // anew: its span is 75% of the view, centred.
    const files = new OpenFiles();
    await openFiles(
      event,
      files,
      deps([resolved("/x/first.cttc-record"), resolved("/x/second.cttc-record")]),
    );
    files.switchTo(1, resolved("/x/first.cttc-record"));
    const again = await openFiles(event, files, deps([resolved("/x/first.cttc-record")]));
    expect(again).toMatchObject({ ok: true, active: resolved("/x/first.cttc-record") });
    const { view } = fileState(first);
    expect((first.to - first.from) / (view.t1 - view.t0)).toBeCloseTo(0.75);
    expect((view.t0 + view.t1) / 2).toBe((first.from + first.to) / 2);
    // The frame is the widest the view goes.
    expect(frameOf(first)).toEqual({ from: view.t0, to: view.t1 });
  });
});

describe("br-ANLYS-000005-sJpO9KMY", () => {
  // BUG-000019-uKKrzikI, Medium: built with roadmap Item 35 (RM-000036-sJpO9KMY).
  it("cttc BUG-000019: Open-file dedup keys on basename only", async () => {
    // cttc matched open files by basename: a second recording.cttc-record from
    // another folder was taken for the first. Files are matched by full path.
    const event = { sender: { id: 1 } };
    const files = new OpenFiles();
    let reads = 0;
    const deps = (chosen: string[]) => ({
      ask: async () => chosen,
      size: async () => 100,
      read: async () => {
        reads++;
        return archiveOver(1_000_000, 2_000_000);
      },
    });
    await openFiles(event, files, deps([resolved("/one/recording.cttc-record")]));
    await openFiles(event, files, deps([resolved("/two/recording.cttc-record")]));
    expect(files.list(1).files.map((f) => f.path)).toEqual([
      resolved("/one/recording.cttc-record"),
      resolved("/two/recording.cttc-record"),
    ]);
    // The same file again is switched to, not read again.
    await openFiles(event, files, deps([resolved("/one/recording.cttc-record")]));
    expect(reads).toBe(2);
    expect(files.list(1)).toMatchObject({ active: resolved("/one/recording.cttc-record") });
  });
});
