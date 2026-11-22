import { describe, expect, it } from "vitest";
import { readCttcArchive } from "../../analysis/archive.js";
import { appendToRecording, type SegmentData } from "../archive.js";
import { parseTarget } from "../ipc.js";
import { PIECE_EVERY_MS, type RecordingDeps, RecordingSession, suggestedName } from "../session.js";

// REQ-000037-sJpO9KMY Requirements 2-4, br-REC-000002-sJpO9KMY: the session and its archive.

const T0 = Date.UTC(2026, 10, 22, 12, 0);

/** What the Sump answers for a range: one row of web's stats and one log line per second. */
function segmentOf(from: number, to: number): SegmentData {
  const rows = [];
  for (let t = from; t < to; t += 1000) rows.push(t);
  return {
    from,
    to,
    sources: [
      {
        type: "stats",
        name: "stats@self",
        is_host: false,
        series: { web: rows.map((t) => [t, 1, 2, 3, 4]) },
      },
      {
        type: "stats",
        name: "host@self",
        is_host: true,
        series: { "host@self": rows.map((t) => [t, 9, 9, 9, 9]) },
      },
      { type: "log", name: "web", rows: rows.map((t) => ({ ts: t, text: `at ${t - T0}` })) },
    ],
  };
}

describe("REQ-000037-sJpO9KMY: the recording archive", () => {
  it("is read back by the analysis view: segments, pieces extending one, the hash kept", () => {
    let bytes = appendToRecording(null, segmentOf(T0, T0 + 3000), "new", "2026-11-22T12:00:00Z");
    bytes = appendToRecording(bytes, segmentOf(T0 + 3000, T0 + 5000), "extend");
    bytes = appendToRecording(bytes, segmentOf(T0 + 9000, T0 + 10_000), "new");
    const file = readCttcArchive(bytes, "/r/run.recording");
    expect(file.warnings).toEqual([]);
    expect([file.from, file.to]).toEqual([T0, T0 + 10_000]);
    expect(file.stats.get("web")?.map((r) => r[0] - T0)).toEqual([0, 1000, 2000, 3000, 4000, 9000]);
    expect(file.host).toHaveLength(6);
    expect(file.logs.get("web")?.map((r) => r.text)).toEqual([
      "at 0",
      "at 1000",
      "at 2000",
      "at 3000",
      "at 4000",
      "at 9000",
    ]);
  });
});

/** A session on fakes: a Sump answering segments, a disk in memory, a clock. */
function setup(over: Partial<RecordingDeps> = {}) {
  const disk = new Map<string, Buffer>();
  const told: string[] = [];
  const states: string[] = [];
  const asked: { from: string; to: string }[] = [];
  const project: string[] = [];
  let now = T0;
  let saveTo: string | null = "/out/run.recording";
  let sumpUp = true;
  const deps: RecordingDeps = {
    scratch: "/data/recording-in-progress.recording",
    fetchSegment: async (_sump, q) => {
      asked.push({ from: q.from as string, to: q.to as string });
      if (!sumpUp) return { ok: false, error: { message: "Sump unreachable" } };
      return {
        ok: true,
        value: segmentOf(Date.parse(q.from as string), Date.parse(q.to as string)),
      };
    },
    read: async (f) => disk.get(f) ?? null,
    write: async (f, b) => void disk.set(f, b),
    askSave: async () => saveTo,
    copy: async (from, to) => {
      const b = disk.get(from);
      if (!b) throw new Error("no scratch");
      disk.set(to, b);
    },
    addToProject: (f) => void project.push(f),
    notify: (t) => void told.push(t),
    changed: (s) => void states.push(s.status),
    now: () => now,
    ...over,
  };
  const session = new RecordingSession(deps);
  return {
    session,
    disk,
    told,
    states,
    asked,
    project,
    at: (t: number) => {
      now = T0 + t;
    },
    saveTo: (p: string | null) => {
      saveTo = p;
    },
    sump: (up: boolean) => {
      sumpUp = up;
    },
  };
}

const target = { sump: "local", stream: "self", containers: ["web"], host: true };

describe("br-REC-000002-sJpO9KMY: the recording session", () => {
  it("records segments from Record to Pause into one recording, saved where the user chose", async () => {
    const s = setup();
    await s.session.start(target);
    expect(s.session.state()).toMatchObject({ status: "recording", segmentStart: T0 });
    s.at(4000);
    await s.session.pause();
    expect(s.session.state()).toMatchObject({
      status: "paused",
      segments: [{ from: T0, to: T0 + 4000 }],
    });
    s.at(10_000);
    await s.session.start();
    s.at(12_000);
    const stopped = await s.session.stop();
    expect(stopped.status).toBe("idle");
    const file = readCttcArchive(s.disk.get("/out/run.recording") as Buffer, "/out/run.recording");
    expect(file.stats.get("web")?.map((r) => r[0] - T0)).toEqual([
      0, 1000, 2000, 3000, 10_000, 11_000,
    ]);
    expect(s.project).toEqual(["/out/run.recording"]);
    expect(s.states).toEqual(["recording", "paused", "recording", "stopped", "idle"]);
  });

  it("stays recording when a flush fails, and says why", async () => {
    const s = setup();
    await s.session.start(target);
    s.sump(false);
    s.at(2000);
    expect((await s.session.pause()).status).toBe("recording");
    expect((await s.session.stop()).status).toBe("recording");
    expect(s.told.filter((t) => t.includes("Sump unreachable"))).toHaveLength(2);
    s.sump(true);
    expect((await s.session.pause()).status).toBe("paused");
  });

  it("stays stopped when the save is cancelled or fails, and Stop asks again", async () => {
    const s = setup();
    await s.session.start(target);
    s.at(2000);
    s.saveTo(null);
    expect((await s.session.stop()).status).toBe("stopped");
    const failing = setup({ copy: async () => Promise.reject(new Error("disk full")) });
    await failing.session.start(target);
    failing.at(1000);
    expect((await failing.session.stop()).status).toBe("stopped");
    expect(failing.told.some((t) => t.includes("disk full"))).toBe(true);
    s.saveTo("/out/later.recording");
    expect((await s.session.stop()).status).toBe("idle");
    expect(s.disk.has("/out/later.recording")).toBe(true);
  });

  it("starts with no prompt and an empty scratch file; nothing without containers", async () => {
    const s = setup();
    s.disk.set("/data/recording-in-progress.recording", Buffer.from("old"));
    await s.session.start({ ...target, containers: [] });
    expect(s.session.state().status).toBe("idle");
    await s.session.start(target);
    expect(s.disk.get("/data/recording-in-progress.recording")?.length).toBe(0);
  });

  it("flushes every 10 minutes as pieces of the same segment, asking only the new range", async () => {
    const s = setup();
    await s.session.start(target);
    s.at(PIECE_EVERY_MS);
    await s.session.tick();
    s.at(PIECE_EVERY_MS + 3000);
    await s.session.pause();
    expect(s.asked.map((a) => [Date.parse(a.from) - T0, Date.parse(a.to) - T0])).toEqual([
      [0, PIECE_EVERY_MS],
      [PIECE_EVERY_MS, PIECE_EVERY_MS + 3000],
    ]);
    const scratch = readCttcArchive(
      s.disk.get("/data/recording-in-progress.recording") as Buffer,
      "/data/x.recording",
    );
    expect([scratch.from, scratch.to]).toEqual([T0, T0 + PIECE_EVERY_MS + 3000]);
    expect(s.session.state().segments).toEqual([{ from: T0, to: T0 + PIECE_EVERY_MS + 3000 }]);
  });

  it("names a recording after its stream and start; checks Start's target", () => {
    expect(suggestedName("ssh:ops@lab:22", T0)).toBe(
      "ssh_ops_lab_22-2026-11-22-12-00-00.recording",
    );
    expect(parseTarget({ stream: "self", containers: ["web"], host: true }, "local")).toEqual(
      target,
    );
    expect(() => parseTarget({ stream: "a b" }, "local")).toThrow();
  });
});
