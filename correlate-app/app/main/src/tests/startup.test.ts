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
    const menus: unknown[] = [];
    let ready: (() => void) | undefined;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    class BrowserWindow {
      static getAllWindows = () => windows;
      static fromWebContents = () => null;
      webContents = { id: windows.length + 1, send: () => {}, on: () => {} };
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
        name: "correlate-app",
        quit: () => {},
        // The app runs once (REQ-036): this is the first.
        requestSingleInstanceLock: () => true,
      },
      BrowserWindow,
      Menu: {
        setApplicationMenu: (menu: unknown) => void menus.push(menu),
        buildFromTemplate: (template: unknown) => ({ template }),
      },
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
      "status:history",
      "status:add",
      "status:clear",
      "status:visible",
      "status:setVisible",
      "menu:action",
      "picker:lastStream",
      "picker:setLastStream",
      "stream:active",
      "stream:setActive",
      "open:take",
      "project:get",
      "project:addPaths",
      "recording:get",
      "recording:start",
      "recording:stop",
      "recording:resume",
      "recording:discard",
      "export:capture",
      "export:saveSnapshot",
    ]) {
      expect(channels).toContain(channel);
    }
    // A native menu on macOS only (REQ-000023).
    expect(menus).toHaveLength(1);
    expect(menus[0] === null).toBe(process.platform !== "darwin");
    // The OS's files are heard for from the start (REQ-036).
    expect(appEvents.has("open-file")).toBe(true);
    expect(appEvents.has("second-instance")).toBe(true);
    appEvents.get("will-quit")?.();
  });
});
