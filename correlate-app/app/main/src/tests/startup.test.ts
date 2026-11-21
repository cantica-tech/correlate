import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import * as bundle from "../index.js";

// `main.cjs` itself, run with a fake Electron and the real main-process code:
// a name it uses but never takes from the bundle only fails when the app
// starts (it did twice, in STEP-000051 and STEP-000064). This test starts it.

const MAIN_CJS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../main.cjs");
const dir = mkdtempSync(path.join(tmpdir(), "startup-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("main.cjs starts", () => {
  it("registers every bridge channel and opens a window, without a missing name", async () => {
    const channels: string[] = [];
    const appEvents = new Map<string, () => void>();
    const windows: unknown[] = [];
    let ready: (() => void) | undefined;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    class BrowserWindow {
      static getAllWindows = () => windows;
      webContents = { id: windows.length + 1, send: () => {} };
      constructor() {
        windows.push(this);
      }
      on() {}
      loadFile() {}
    }
    const electron = {
      app: {
        whenReady: () => readyPromise,
        on: (event: string, handler: () => void) => void appEvents.set(event, handler),
        getPath: () => dir,
        getVersion: () => "0.1.0",
        quit: () => {},
      },
      BrowserWindow,
      ipcMain: { handle: (channel: string) => void channels.push(channel) },
      nativeTheme: { themeSource: "system" },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => "",
      },
    };
    const env = {
      ...process.env,
      CORRELATE_CATALOG: path.join(dir, "catalog.db"),
      CORRELATE_SETTINGS: path.join(dir, "settings.json"),
    };
    const sandboxRequire = (name: string) => {
      if (name === "electron") return electron;
      if (name === "./main/dist/main.cjs") return bundle;
      if (name === "node:path") return path;
      throw new Error(`main.cjs requires ${name}`);
    };
    const errors: unknown[] = [];
    vm.runInNewContext(readFileSync(MAIN_CJS, "utf8"), {
      require: sandboxRequire,
      __dirname: path.dirname(MAIN_CJS),
      process: { ...process, env, platform: process.platform },
      console: { ...console, info: () => {}, warn: () => {} },
    });
    ready?.();
    await readyPromise
      .then(() => new Promise((r) => setTimeout(r, 50)))
      .catch((e) => errors.push(e));
    expect(errors).toEqual([]);
    expect(windows).toHaveLength(1);
    for (const channel of [
      "sump:request",
      "sump:active",
      "sump:states",
      "sump:plan",
      "sump:audit",
      "theme:get",
      "theme:set",
      "sidebar:get",
      "sidebar:set",
      "sidebar:action",
    ]) {
      expect(channels).toContain(channel);
    }
    appEvents.get("will-quit")?.();
  });
});
