import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultSettingsPath,
  registerThemeIpc,
  Settings,
  THEME_GET_CHANNEL,
  THEME_SET_CHANNEL,
} from "../theme.js";

// REQ-000018-sJpO9KMY Requirement 3: the theme choice, remembered.

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "theme-test-"));
  file = path.join(dir, ".correlate", "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const quiet = { warn: () => {} };

describe("REQ-000018-sJpO9KMY: the theme choice", () => {
  it("follows the system by default", () => {
    expect(new Settings(file, quiet).themeMode()).toBe("system");
  });

  it("remembers a choice across runs, owner-only", () => {
    new Settings(file, quiet).setThemeMode("dark");
    expect(new Settings(file, quiet).themeMode()).toBe("dark");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ themeMode: "dark" });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
  });

  it("refuses anything but system, light or dark", () => {
    const settings = new Settings(file, quiet);
    expect(() => settings.setThemeMode("blue")).toThrow(/system, light, dark/);
    expect(settings.themeMode()).toBe("system");
  });

  it("uses system, and says so, when the file is unreadable", () => {
    new Settings(file, quiet).setThemeMode("light");
    writeFileSync(file, "{ nope");
    const warnings: string[] = [];
    expect(new Settings(file, { warn: (m) => warnings.push(m) }).themeMode()).toBe("system");
    expect(warnings[0]).toContain("unreadable");
  });

  it("answers the bridge and applies the choice", async () => {
    const handlers = new Map<string, (event: unknown, message: unknown) => unknown>();
    const applied: string[] = [];
    registerThemeIpc(
      { handle: (channel, handler) => void handlers.set(channel, handler as never) },
      new Settings(file, quiet),
      (mode) => applied.push(mode),
    );
    const call = (channel: string, value?: unknown) =>
      (handlers.get(channel) as (e: unknown, m: unknown) => unknown)({}, value);
    expect(await call(THEME_GET_CHANNEL)).toBe("system");
    expect(await call(THEME_SET_CHANNEL, "light")).toEqual({ ok: true, mode: "light" });
    expect(await call(THEME_SET_CHANNEL, 7)).toMatchObject({ ok: false });
    expect(applied).toEqual(["light"]);
    expect(await call(THEME_GET_CHANNEL)).toBe("light");
  });

  it("lives in ~/.correlate unless CORRELATE_SETTINGS says otherwise", () => {
    expect(defaultSettingsPath({})).toMatch(/\.correlate[\\/]settings\.json$/);
    expect(defaultSettingsPath({ CORRELATE_SETTINGS: "/x/s.json" })).toBe("/x/s.json");
  });
});

describe("REQ-000021-sJpO9KMY: other parts beside the theme", () => {
  it("keeps each part when another is written, and refuses the theme as a part", () => {
    const settings = new Settings(file, quiet);
    settings.setPart("sidebar", { dock: "right" });
    settings.setThemeMode("dark");
    const again = new Settings(file, quiet);
    expect(again.part("sidebar")).toEqual({ dock: "right" });
    expect(again.themeMode()).toBe("dark");
    expect(() => again.setPart("themeMode", "light")).toThrow(/setThemeMode/);
  });

  it("reads a file that is not an object as unreadable", () => {
    writeFileSync(path.join(dir, "x.json"), "[]");
    const warnings: string[] = [];
    new Settings(path.join(dir, "x.json"), { warn: (m) => warnings.push(m) });
    expect(warnings[0]).toContain("not an object");
  });
});
