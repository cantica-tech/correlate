import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  lastStream,
  PICKER_LAST_CHANNEL,
  PICKER_SET_LAST_CHANNEL,
  registerPickerIpc,
  setLastStream,
} from "../picker.js";
import { Settings } from "../theme.js";

// REQ-000026-sJpO9KMY Requirement 3: the picker's last stream, per Sump.

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "picker-test-"));
  file = path.join(dir, "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const quiet = { warn: () => {} };

describe("REQ-000026-sJpO9KMY: the picker's last stream", () => {
  it("is kept per Sump, across restarts, beside the theme", () => {
    const settings = new Settings(file, quiet);
    settings.setThemeMode("dark");
    setLastStream(settings, "local", "ssh:ops@lab:2222");
    setLastStream(settings, "remote-1", "self");
    setLastStream(settings, "local", "self");
    const again = new Settings(file, quiet);
    expect(lastStream(again, "local")).toBe("self");
    expect(lastStream(again, "remote-1")).toBe("self");
    expect(lastStream(again, "elsewhere")).toBeNull();
    expect(again.themeMode()).toBe("dark");
  });

  it.each([
    ["", "self"],
    ["local", ""],
    ["local", "a b"],
    ["local", "x".repeat(201)],
    [42, "self"],
  ])("refuses %j, %j", (sump, stream) => {
    expect(() => setLastStream(new Settings(file, quiet), sump, stream)).toThrow(/200 printable/);
  });

  it("answers the bridge, a refusal as { ok: false }", async () => {
    const handlers = new Map<string, (event: unknown, message: unknown) => unknown>();
    const settings = new Settings(file, quiet);
    registerPickerIpc({ handle: (c, f) => void handlers.set(c, f as never) }, settings);
    const call = (c: string, m?: unknown) =>
      (handlers.get(c) as (e: unknown, m: unknown) => unknown)({}, m);
    expect(await call(PICKER_LAST_CHANNEL, "local")).toBeNull();
    expect(await call(PICKER_SET_LAST_CHANNEL, { sump: "local", stream: "self" })).toEqual({
      ok: true,
    });
    expect(await call(PICKER_LAST_CHANNEL, "local")).toBe("self");
    expect(await call(PICKER_SET_LAST_CHANNEL, { sump: "local" })).toMatchObject({ ok: false });
  });
});
