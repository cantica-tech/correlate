import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureConsole, windowError } from "../capture.js";
import { isRoutineSumpLine } from "../classify.js";
import { followLocalSump, sumpLine } from "../follow.js";
import {
  besideTheApp,
  KEEP_FILES,
  logFileName,
  OwnLog,
  type OwnLogSettings,
  parseOwnLogSettings,
} from "../ownlog.js";

// REQ-000048-sJpO9KMY: br-DIAG-000001-sJpO9KMY and br-DIAG-000003-sJpO9KMY.

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ownlog-test-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** An own log over a settings object; `next` the app folder, `data` the fallback. */
function setup(kept?: OwnLogSettings, over: Partial<ConstructorParameters<typeof OwnLog>[0]> = {}) {
  const store: { value: OwnLogSettings | undefined } = { value: kept };
  const warned: string[] = [];
  let t = Date.UTC(2026, 10, 22, 19, 0, 0);
  const log = new OwnLog({
    read: () => store.value,
    write: (s) => {
      store.value = s;
    },
    defaultDir: path.join(root, "next"),
    fallbackDir: path.join(root, "data"),
    warn: (text) => void warned.push(text),
    now: () => new Date(t++),
    ...over,
  });
  return { log, store, warned };
}

const read = (file: string | null) => (file ? readFileSync(file, "utf8") : "");

describe("br-DIAG-000001-sJpO9KMY: the own log", () => {
  it("is on by default on a never-configured install, one file per start next to the app", () => {
    const s = setup();
    s.log.start();
    expect(s.store.value).toEqual({ enabled: true, dir: path.join(root, "next") });
    s.log.write("INFO", "hello\nsecond line");
    const file = s.log.current();
    expect(file).toMatch(/next[/\\]correlate-2026-11-22T19-00-00-000Z\.log$/);
    expect(read(file)).toMatch(
      /^.+ INFO correlate-app's own log starts\n.+ INFO hello\n {4}second line\n$/,
    );
  });

  it("falls back once to the data folder, then turns itself off and says so", () => {
    let failing = (f: string) => f.includes(`${path.sep}next${path.sep}`);
    const s = setup(undefined, {
      append: (f, t) => {
        if (failing(f)) throw new Error("read-only");
        writeFileSync(f, t, { flag: "a" });
      },
    });
    s.log.start();
    expect(s.log.current()).toContain(`${path.sep}data${path.sep}`);
    expect(s.store.value).toEqual({ enabled: true, dir: path.join(root, "data") });
    expect(s.warned[0]).toMatch(
      /couldn't write to .+next \(read-only\) -- falling back to .+data$/,
    );
    // The data folder fails too: off, said, and nothing more is written.
    failing = () => true;
    s.log.write("ERROR", "lost");
    expect(s.store.value?.enabled).toBe(false);
    expect(s.log.current()).toBeNull();
    expect(s.warned[1]).toMatch(/turning the own log off$/);
  });

  it("stays off when turned off, and starts a new file when turned on", () => {
    const s = setup({ enabled: false, dir: null });
    s.log.start();
    expect(s.log.current()).toBeNull();
    s.log.set({ enabled: true, dir: path.join(root, "chosen") });
    expect(s.log.current()).toContain(`${path.sep}chosen${path.sep}`);
  });

  it(`keeps the ${KEEP_FILES} latest starts' files`, () => {
    const dir = path.join(root, "next");
    const s = setup();
    s.log.start();
    for (let i = 0; i < 25; i++)
      writeFileSync(path.join(dir, logFileName(new Date(Date.UTC(2026, 0, 1, 0, i)))), "x");
    writeFileSync(path.join(dir, "notes.txt"), "mine");
    // A later start: its own file.
    setup({ enabled: true, dir }, { now: () => new Date(Date.UTC(2026, 10, 23)) }).log.start();
    const left = readdirSync(dir);
    expect(left.filter((f) => f.endsWith(".log"))).toHaveLength(KEEP_FILES);
    expect(left).toContain("notes.txt");
    expect(existsSync(path.join(dir, logFileName(new Date(Date.UTC(2026, 0, 1, 0, 0)))))).toBe(
      false,
    );
  });

  it("reads its settings, and treats anything else as never configured", () => {
    expect(parseOwnLogSettings({ enabled: false, dir: "/x" })).toEqual({
      enabled: false,
      dir: "/x",
    });
    expect(parseOwnLogSettings({ enabled: "yes" })).toBeUndefined();
    expect(parseOwnLogSettings(undefined)).toBeUndefined();
  });
});

describe("REQ-000048-sJpO9KMY: what the own log holds", () => {
  it("copies the console's lines at their level, still printing them", () => {
    const s = setup();
    s.log.start();
    const printed: string[] = [];
    const fake = {
      debug: (...a: unknown[]) => void printed.push(`d ${a.join(" ")}`),
      log: (...a: unknown[]) => void printed.push(`l ${a.join(" ")}`),
      info: (...a: unknown[]) => void printed.push(`i ${a.join(" ")}`),
      warn: (...a: unknown[]) => void printed.push(`w ${a.join(" ")}`),
      error: (...a: unknown[]) => void printed.push(`e ${a.join(" ")}`),
    } as unknown as Console;
    const undo = captureConsole(s.log, fake);
    fake.info("notification: Recording saved");
    fake.warn("slow", { ms: 5 });
    fake.error(new Error("boom"));
    undo();
    fake.info("not copied");
    const text = read(s.log.current());
    expect(text).toContain(" INFO notification: Recording saved\n");
    expect(text).toContain(' WARN slow {"ms":5}\n');
    expect(text).toMatch(/ ERROR Error: boom\n/);
    expect(text).not.toContain("not copied");
    expect(printed).toHaveLength(4);
  });

  it("takes a window's errors, with where they came from", () => {
    expect(
      windowError({
        level: "error",
        message: "Uncaught TypeError: x",
        sourceId: "app.js",
        lineNumber: 4,
      }),
    ).toBe("window: Uncaught TypeError: x (app.js:4)");
    expect(windowError({ level: "warning", message: "meh" })).toBeNull();
  });
});

describe("br-DIAG-000003-sJpO9KMY: the Sump's lines, classified", () => {
  it.each([
    ["INFO:correlate_sump.app:plugins loaded: events, ssh", true],
    ["DEBUG:asyncio:Using selector", true],
    ['INFO:     127.0.0.1:52000 - "GET /health HTTP/1.1" 200 OK', true],
    ["2026-11-22 19:00:00,123 INFO spawned: 'sump' with pid 7", true],
    ["[2026/11/22 19:00:00] [ info] [fluent bit] version=3.1", true],
    ["WARNING:correlate_sump.runtime:plugin 'ssh' crashed; restarting", false],
    ["ERROR:uvicorn.error:Exception in ASGI application", false],
    ["2026-11-22 19:00:00,123 WARN exited: sump (exit status 1)", false],
    ["[2026/11/22 19:00:00] [error] [output] connection refused", false],
    ["Traceback (most recent call last):", false],
    ['  File "/app/x.py", line 3, in <module>', false],
  ])("%s is routine: %s", (line, routine) => {
    expect(isRoutineSumpLine(line)).toBe(routine);
  });

  it("writes routine lines as INFO and the rest as ERROR, skipping blank ones", () => {
    const s = setup();
    s.log.start();
    sumpLine(s.log, "INFO:correlate_sump.app:ready");
    sumpLine(s.log, "Traceback (most recent call last):");
    sumpLine(s.log, "   ");
    const text = read(s.log.current());
    expect(text).toContain(" INFO sump: INFO:correlate_sump.app:ready\n");
    expect(text).toContain(" ERROR sump: Traceback (most recent call last):\n");
  });

  it("follows the local Sump while it runs, trying again when it is not", async () => {
    const s = setup();
    s.log.start();
    const timers: (() => void)[] = [];
    let running: string | null = null;
    let push: (line: string) => void = () => {};
    let end: () => void = () => {};
    const stop = followLocalSump(s.log, {
      container: async () => running,
      follow: (_id, onLine, onEnd) => {
        push = onLine;
        end = onEnd;
        return () => {};
      },
      setTimer: (run) => void timers.push(run),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(timers).toHaveLength(1);
    running = "abc";
    timers[0]?.();
    await new Promise((r) => setTimeout(r, 0));
    push("WARNING:correlate_sump.app:slow");
    end();
    expect(timers).toHaveLength(2);
    stop();
    expect(read(s.log.current())).toContain(" ERROR sump: WARNING:correlate_sump.app:slow\n");
  });
});

describe("REQ-000054-sJpO9KMY: next to a packaged app", () => {
  it("is beside the .app bundle on macOS, never inside it", () => {
    expect(
      besideTheApp("/Applications/correlate-app.app/Contents/MacOS/correlate-app", "darwin"),
    ).toBe("/Applications");
  });

  it("is the executable's folder elsewhere", () => {
    expect(besideTheApp("/opt/correlate-app/correlate-app", "linux")).toBe("/opt/correlate-app");
    expect(besideTheApp("/tmp/correlate-app", "darwin")).toBe("/tmp");
  });
});
