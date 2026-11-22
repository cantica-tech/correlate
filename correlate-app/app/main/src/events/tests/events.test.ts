import { describe, expect, it } from "vitest";
import type { Sump, SumpEvent, SumpStream } from "../../sump/client.js";
import { FiringsFollower, type FollowerDeps, firingText } from "../firings.js";
import { artifactName, type DownloadDeps, downloadArtifact } from "../ipc.js";

// REQ-000046-sJpO9KMY Requirements 2 and 4: firings followed, artifacts saved.

/** A fake Sump world: streams opened, their events and ends, timers run by hand. */
function world(logged: string[] = ["local"]) {
  const opened: {
    sump: string;
    query?: Record<string, string>;
    push: (e: SumpEvent) => void;
    end: () => void;
  }[] = [];
  const said: string[] = [];
  const told: unknown[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const sumps = [...logged];
  const deps: FollowerDeps = {
    sumps: () => sumps,
    resolve: (id) => ({ name: id, baseUrl: `http://${id}`, token: "t" }) as Sump,
    name: (id) => `Sump ${id}`,
    open: (sump, _path, onEvent, options) => {
      let end: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        end = resolve;
      });
      opened.push({ sump: sump.name, query: options.query, push: onEvent, end });
      return { close: () => end(), done } as SumpStream;
    },
    notify: (text) => void said.push(text),
    told: (f) => void told.push(f),
    retryMs: 100,
    maxRetryMs: 400,
    setTimer: (run, ms) => {
      timers.push({ run, ms });
      return timers.length;
    },
    clearTimer: () => {},
  };
  return { deps, opened, said, told, timers, sumps };
}

const firing = (id: string, name = "busy") => ({
  event: "firing",
  id,
  data: JSON.stringify({ event: "evt-1", name, at: "1", detail: "web cpu 92.0 > 50" }),
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("REQ-000046-sJpO9KMY: following firings", () => {
  it("says each firing in the status bar and tells the windows", () => {
    const w = world();
    const f = new FiringsFollower(w.deps);
    f.sync();
    w.opened[0]?.push(firing("1-0"));
    w.opened[0]?.push({ event: "message", data: "ignored" });
    expect(w.said).toEqual(['Event "busy" fired: web cpu 92.0 > 50']);
    expect(w.told).toEqual([expect.objectContaining({ sump: "local", id: "1-0", name: "busy" })]);
  });

  it("names the Sump when it follows several", () => {
    const w = world(["a", "b"]);
    new FiringsFollower(w.deps).sync();
    w.opened[1]?.push(firing("1-0"));
    expect(w.said).toEqual(['Event "busy" fired on Sump b: web cpu 92.0 > 50']);
  });

  it("reconnects after a drop with a growing wait, resuming after the last firing", async () => {
    const w = world();
    new FiringsFollower(w.deps).sync();
    w.opened[0]?.push(firing("5-0"));
    w.opened[0]?.end();
    await settle();
    expect(w.timers.map((t) => t.ms)).toEqual([100]);
    w.timers[0]?.run();
    expect(w.opened[1]?.query).toEqual({ after: "5-0" });
    w.opened[1]?.end();
    await settle();
    w.timers[1]?.run();
    w.opened[2]?.end();
    await settle();
    expect(w.timers.map((t) => t.ms)).toEqual([100, 200, 400]);
  });

  it("follows a Sump once logged in and stops at logout", () => {
    const w = world([]);
    const f = new FiringsFollower(w.deps);
    f.sync();
    expect(w.opened).toHaveLength(0);
    w.sumps.push("local");
    f.sync();
    f.sync();
    expect(f.following()).toEqual(["local"]);
    expect(w.opened).toHaveLength(1);
    w.sumps.pop();
    f.sync();
    expect(f.following()).toEqual([]);
  });

  it("says a firing's note", () => {
    expect(
      firingText(
        {
          event: "e",
          name: "rec",
          at: "1",
          detail: "x",
          note: "a recording of this event is still running",
        },
        null,
      ),
    ).toBe('Event "rec" fired: x (a recording of this event is still running)');
  });
});

describe("REQ-000046-sJpO9KMY: saving an artifact (cttc bug 26)", () => {
  const deps = (
    answer: string | null,
    bytes: Buffer | Error,
    written: Map<string, Buffer>,
  ): DownloadDeps => ({
    askSave: async () => answer,
    bytes: async () => {
      if (bytes instanceof Error) throw bytes;
      return bytes;
    },
    write: (file, b) => void written.set(file, b),
  });
  const id = "0123456789abcdef";

  it("asks where, fetches, checks the size, then writes", async () => {
    const written = new Map<string, Buffer>();
    const r = await downloadArtifact(
      {},
      { artifact: id, name: "busy", size: 3 },
      deps("/p/a.recording", Buffer.from("abc"), written),
    );
    expect(r).toEqual({ ok: true, file: "/p/a.recording" });
    expect(written.get("/p/a.recording")?.toString()).toBe("abc");
  });

  it("writes nothing short, failed, cancelled or not an artifact", async () => {
    const written = new Map<string, Buffer>();
    expect(
      await downloadArtifact(
        {},
        { artifact: id, name: "x", size: 10 },
        deps("/p", Buffer.from("abc"), written),
      ),
    ).toEqual({
      ok: false,
      message: "got 3 bytes of the Sump's 10: not saved",
    });
    const pending = new Error("HTTP 409: the artifact is pending");
    expect(
      await downloadArtifact({}, { artifact: id, size: 3 }, deps("/p", pending, written)),
    ).toEqual({
      ok: false,
      message: "HTTP 409: the artifact is pending",
    });
    expect(
      await downloadArtifact({}, { artifact: id }, deps(null, Buffer.from(""), written)),
    ).toEqual({ ok: false, cancelled: true });
    expect(
      await downloadArtifact({}, { artifact: "../x" }, deps("/p", Buffer.from(""), written)),
    ).toEqual({
      ok: false,
      message: "not an artifact",
    });
    expect(written.size).toBe(0);
  });

  it("names the file from the event, safely", () => {
    expect(artifactName("high CPU / api", id)).toBe(`high-CPU-api-${id}.recording`);
    // No separator survives: the name stays in the chosen folder.
    expect(artifactName("../..", id)).toBe(`..-..-${id}.recording`);
    expect(artifactName("a\\b/c", id)).not.toMatch(/[\\/]/);
  });
});
