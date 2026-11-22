import { describe, expect, it } from "vitest";
import { readCttcArchive } from "../../analysis/archive.js";
import { appendToRecording, type SegmentData } from "../../recording/archive.js";
import { type CaptureDeps, capture, captureName, parseCapture, sliceFile } from "../capture.js";
import { saveSnapshot } from "../ipc.js";

// REQ-000041-sJpO9KMY Requirements 1-2: capturing a range, saving a snapshot.

const T0 = Date.UTC(2026, 10, 22, 12, 0);

/** One row a second of web's and db's stats, the host's, and web's logs, over `from`..`to`. */
function segment(from: number, to: number): SegmentData {
  const ts: number[] = [];
  for (let t = from; t < to; t += 1000) ts.push(t);
  return {
    from,
    to,
    sources: [
      {
        type: "stats",
        name: "stats@self",
        is_host: false,
        series: {
          web: ts.map((t) => [t, 1, 2, 3, 4]),
          db: ts.map((t) => [t, 5, 6, 7, 8]),
        },
      },
      {
        type: "stats",
        name: "host@local",
        is_host: true,
        series: { local: ts.map((t) => [t, 9, 9, 9, 9]) },
      },
      { type: "log", name: "web", rows: ts.map((t) => ({ ts: t, text: `at ${(t - T0) / 1000}` })) },
    ],
  };
}

/** A capture's fakes: the save dialog's answer, the Sump, the shown file, the disk. */
function fakes(answer: string | null, over: Partial<CaptureDeps> = {}) {
  const asked: Record<string, string>[] = [];
  const written = new Map<string, Buffer>();
  const order: string[] = [];
  const deps: CaptureDeps = {
    askSave: async (name) => {
      order.push(`ask ${name}`);
      return answer;
    },
    fetchSegment: async (query) => {
      order.push("fetch");
      asked.push(query);
      return { ok: true, value: segment(Date.parse(query.from), Date.parse(query.to)) };
    },
    shownFile: () => undefined,
    write: async (file, bytes) => {
      order.push("write");
      written.set(file, bytes);
    },
    ...over,
  };
  return { deps, asked, written, order };
}

const live = {
  view: "live" as const,
  stream: "self",
  containers: ["web"],
  host: true,
  from: T0 + 2000,
  to: T0 + 5000,
};

describe("br-EXPORT-000002-sJpO9KMY: the destination first", () => {
  it("asks where to save before reading anything, and a cancel reads and writes nothing", async () => {
    const f = fakes(null);
    expect(await capture(live, f.deps)).toEqual({ ok: false, cancelled: true });
    expect(f.order).toEqual(["ask capture-2026-11-22-12-00-02.recording"]);
    expect(f.written.size).toBe(0);
  });

  it("writes nothing when the Sump fails, and says why", async () => {
    const f = fakes("/out/c.recording", {
      fetchSegment: async () => ({ ok: false, error: { message: "Sump unreachable" } }),
    });
    expect(await capture(live, f.deps)).toEqual({ ok: false, message: "Sump unreachable" });
    expect(f.written.size).toBe(0);
  });
});

describe("br-EXPORT-000003-sJpO9KMY: capturing a range", () => {
  it("saves the live view's range from the Sump as a one-segment recording", async () => {
    const f = fakes("/out/c.recording");
    expect(await capture(live, f.deps)).toEqual({
      ok: true,
      file: "/out/c.recording",
      empty: false,
    });
    expect(f.order).toEqual(["ask capture-2026-11-22-12-00-02.recording", "fetch", "write"]);
    expect(f.asked).toEqual([
      {
        sources: "self/web",
        host: "self/__host__",
        from: new Date(T0 + 2000).toISOString(),
        to: new Date(T0 + 5000).toISOString(),
      },
    ]);
    const file = readCttcArchive(f.written.get("/out/c.recording") as Buffer, "/out/c.recording");
    expect([file.from, file.to]).toEqual([T0 + 2000, T0 + 5000]);
  });

  it("asks no host of the Sump when the host's block is not shown", async () => {
    const f = fakes("/out/c.recording");
    await capture({ ...live, host: false }, f.deps);
    expect(f.asked[0]).not.toHaveProperty("host");
  });

  it("cuts the analysis view's range from the shown file, asking no Sump", async () => {
    const shown = readCttcArchive(
      appendToRecording(null, segment(T0, T0 + 10_000), "new"),
      "/in/a.recording",
    );
    const f = fakes("/out/c.recording", { shownFile: () => shown });
    const r = await capture({ ...live, view: "file", containers: ["web"], host: true }, f.deps);
    expect(r).toMatchObject({ ok: true });
    expect(f.asked).toEqual([]);
    const file = readCttcArchive(f.written.get("/out/c.recording") as Buffer, "/out/c.recording");
    // Only what the view shows: web (not db), the host, web's logs, 2 s to 5 s.
    expect([...file.stats.keys()]).toEqual(["web"]);
    expect(file.stats.get("web")?.map((r) => r[0] - T0)).toEqual([2000, 3000, 4000, 5000]);
    expect(file.host).toHaveLength(4);
    expect(file.hostName).toBe("localhost");
    expect(file.logs.get("web")?.map((r) => r.text)).toEqual(["at 2", "at 3", "at 4", "at 5"]);
  });

  it("refuses a file capture when the window shows no file", async () => {
    const f = fakes("/out/c.recording");
    expect(await capture({ ...live, view: "file" }, f.deps)).toEqual({
      ok: false,
      message: "this window shows no file",
    });
    expect(f.order).toEqual([]);
  });

  it("says when the range holds nothing", () => {
    const shown = readCttcArchive(appendToRecording(null, segment(T0, T0 + 3000), "new"), "/a");
    expect(sliceFile(shown, ["web"], true, T0 + 60_000, T0 + 70_000).sources).toEqual([]);
  });

  it.each([
    [{ ...live, view: "other" }, /live view or of a file/],
    [{ ...live, stream: "a b" }, /not a data stream/],
    [{ ...live, containers: ["ok", 7] }, /up to 200 names/],
    [{ ...live, to: live.from }, /needs a range/],
  ])("refuses %j", (message, why) => {
    expect(() => parseCapture(message)).toThrow(why);
  });

  it("names the capture after its start, as cttc", () => {
    expect(captureName(T0)).toBe("capture-2026-11-22-12-00-00.recording");
  });
});

describe("br-EXPORT-000004-sJpO9KMY: saving a snapshot", () => {
  const deps = (answer: string | null, written: Map<string, string>) => ({
    capture: () => fakes(null).deps,
    metrics: () => ({ scope: () => undefined, askSave: async () => null, write: async () => {} }),
    askSaveSnapshot: async () => answer,
    write: async (file: string, content: string) => void written.set(file, content),
  });

  it("asks where, then writes the shown snapshot", async () => {
    const written = new Map<string, string>();
    const r = await saveSnapshot(
      {},
      { name: "snapshot-x.txt", content: "Snapshot @", kind: "txt" },
      deps("/out/s.txt", written),
    );
    expect(r).toEqual({ ok: true, file: "/out/s.txt" });
    expect(written.get("/out/s.txt")).toBe("Snapshot @");
  });

  it("writes nothing when cancelled, and refuses a name with a folder", async () => {
    const written = new Map<string, string>();
    expect(
      await saveSnapshot({}, { name: "s.json", content: "{}", kind: "json" }, deps(null, written)),
    ).toEqual({ ok: false, cancelled: true });
    expect(
      await saveSnapshot(
        {},
        { name: "../s.json", content: "{}", kind: "json" },
        deps("/x", written),
      ),
    ).toEqual({ ok: false, message: "not a snapshot" });
    expect(written.size).toBe(0);
  });
});
