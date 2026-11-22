import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APPEARANCE_DEFAULTS,
  appearance,
  registerAppearanceIpc,
  setAppearance,
} from "../appearance.js";
import { hardReset, type PreferencesDeps, setOwnLog } from "../preferences.js";
import { Settings } from "../theme.js";

// REQ-000050-sJpO9KMY: the Preferences dialog's main-process side.

let dir: string;
let settings: Settings;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "prefs-test-"));
  settings = new Settings(path.join(dir, "settings.json"), { warn: () => {} });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("REQ-000050-sJpO9KMY: the Appearance pane's settings", () => {
  it("are cttc's defaults until changed, each value checked", () => {
    expect(appearance(settings)).toEqual(APPEARANCE_DEFAULTS);
    expect(
      setAppearance(settings, { nowColor: "#AABBCC", nowStyle: "solid", sprockets: false }),
    ).toMatchObject({
      nowColor: "#aabbcc",
      nowStyle: "solid",
      sprockets: false,
    });
    expect(setAppearance(settings, { statusClearSecs: 0 }).statusClearSecs).toBe(1);
    expect(() => setAppearance(settings, { hlColor: "yellow" })).toThrow(/#rrggbb/);
    expect(() => setAppearance(settings, { nowStyle: "wavy" })).toThrow(/dotted, dashed or solid/);
    expect(() => setAppearance(settings, { font: "x" })).toThrow(/no appearance setting font/);
    // Kept, and read back by a new start.
    expect(appearance(new Settings(settings.file, { warn: () => {} })).nowStyle).toBe("solid");
  });

  it("tells every window of a change, and refuses a wrong one", async () => {
    const handlers = new Map<string, (e: unknown, m: unknown) => unknown>();
    const told: unknown[] = [];
    registerAppearanceIpc(
      { handle: (c, f) => void handlers.set(c, f as never) },
      settings,
      (_c, v) => void told.push(v),
    );
    expect(await handlers.get("appearance:set")?.({}, { recordingColor: "#112233" })).toMatchObject(
      { ok: true },
    );
    expect(told).toEqual([expect.objectContaining({ recordingColor: "#112233" })]);
    expect(await handlers.get("appearance:set")?.({}, { recordingColor: "red" })).toMatchObject({
      ok: false,
    });
    expect(told).toHaveLength(1);
  });
});

/** The pane's deps over an own log stand-in. */
function deps(answers: { folder?: string | null; confirm?: boolean } = {}) {
  let state = { enabled: false, dir: null as string | null };
  const calls: string[] = [];
  const d: PreferencesDeps = {
    ownLog: {
      settings: () => state,
      set: (s) => {
        state = s;
        calls.push(`set ${s.enabled} ${s.dir}`);
      },
      current: () => (state.enabled ? `${state.dir}/correlate-x.log` : null),
    },
    settings: { reset: () => void calls.push("reset") },
    askFolder: async () => {
      calls.push("ask");
      return answers.folder ?? null;
    },
    confirmReset: async () => answers.confirm ?? false,
    relaunch: () => void calls.push("relaunch"),
  };
  return { d, calls };
}

describe("br-DIAG-000001-sJpO9KMY: the own log's switch", () => {
  it("asks for a folder to turn it on; cancelled, it stays off", async () => {
    const cancelled = deps({ folder: null });
    expect(await setOwnLog({}, true, cancelled.d)).toEqual({
      enabled: false,
      dir: null,
      current: null,
    });
    expect(cancelled.calls).toEqual(["ask"]);
    const chosen = deps({ folder: "/logs" });
    expect(await setOwnLog({}, true, chosen.d)).toEqual({
      enabled: true,
      dir: "/logs",
      current: "/logs/correlate-x.log",
    });
    expect(await setOwnLog({}, false, chosen.d)).toMatchObject({ enabled: false, dir: "/logs" });
  });
});

describe("REQ-000050-sJpO9KMY: Hard Reset", () => {
  it("does nothing unless the system's confirmation says yes", async () => {
    const no = deps({ confirm: false });
    expect(await hardReset({}, no.d)).toEqual({ ok: false });
    expect(no.calls).toEqual([]);
    const yes = deps({ confirm: true });
    expect(await hardReset({}, yes.d)).toEqual({ ok: true });
    expect(yes.calls).toEqual(["reset", "relaunch"]);
  });

  it("forgets every preference and the layout, as a never-configured install", () => {
    settings.setThemeMode("dark");
    settings.setPart("sidebar", { dock: "right" });
    setAppearance(settings, { nowStyle: "solid" });
    settings.reset();
    expect(JSON.parse(readFileSync(settings.file, "utf8"))).toEqual({ themeMode: "system" });
    expect(appearance(settings)).toEqual(APPEARANCE_DEFAULTS);
  });
});
