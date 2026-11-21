/**
 * br-CONN-000008-sJpO9KMY (REQ-000007-sJpO9KMY Requirement 3): only the Sump
 * client talks to a Sump. This suite fails if any other app source opens a
 * connection, if the renderer's Content Security Policy lets it connect, or
 * if the preload bridge exposes more than the one Sump call.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The one folder allowed to open connections: the Sump client. */
const CLIENT = path.join("main", "src", "sump");

/** Ways to open a connection, each with the name the check reports. */
const NETWORK: [RegExp, string][] = [
  [/\bfetch\s*\(/, "fetch"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bEventSource\b/, "EventSource"],
  [/\bWebSocket\b/, "WebSocket"],
  // Imported or required, not any string that happens to read "http".
  [
    /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["'](node:)?(http|https|http2|net|tls|dgram)["']/,
    "a Node network module",
  ],
  [/\bnet\.request\b|\bClientRequest\b/, "Electron's net module"],
];

/** Source folders and files to scan, relative to `app/`. */
const ROOTS = ["main.cjs", "preload.cjs", "main/src", "renderer/src", "build"];
const SOURCE = /\.(c?js|mjs|tsx?)$/;

/** Every app source file, tests and build output left out. */
function sources(): string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    const full = path.join(APP, relative);
    let entries: string[];
    try {
      entries = readdirSync(full);
    } catch {
      if (SOURCE.test(relative)) found.push(relative);
      return;
    }
    for (const entry of entries) {
      if (entry === "tests" || entry === "dist" || entry === "node_modules") continue;
      walk(path.join(relative, entry));
    }
  };
  for (const root of ROOTS) walk(root);
  return found;
}

/** The ways `text` opens a connection, ignoring comments. */
function networkUses(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  return NETWORK.filter(([pattern]) => pattern.test(code)).map(([, name]) => name);
}

describe("br-CONN-000008-sJpO9KMY: only the Sump client talks to a Sump", () => {
  it("finds the app's sources", () => {
    const files = sources();
    expect(files).toContain("preload.cjs");
    expect(files).toContain(path.join(CLIENT, "client.ts"));
    expect(files.some((f) => f.startsWith(path.join("renderer", "src")))).toBe(true);
  });

  it("finds no connection outside the Sump client", () => {
    const offenders = sources()
      .filter((file) => !file.startsWith(CLIENT + path.sep))
      .flatMap((file) =>
        networkUses(readFileSync(path.join(APP, file), "utf8")).map((use) => `${file}: ${use}`),
      );
    expect(offenders).toEqual([]);
  });

  it.each([
    ["const r = await fetch(url);", "fetch"],
    ["new WebSocket(url)", "WebSocket"],
    ["new EventSource('/live')", "EventSource"],
    ['import http from "node:http";', "a Node network module"],
    ['const net = require("net");', "a Node network module"],
    ['const tls = await import("node:tls");', "a Node network module"],
  ])("catches %s", (line, use) => {
    expect(networkUses(line)).toContain(use);
  });

  it("ignores a string that only reads like a module name", () => {
    expect(networkUses('const kind = "http"; type K = { kind: "net" };')).toEqual([]);
  });

  it("ignores comments", () => {
    expect(networkUses("// no fetch() here\n/* nor fetch() */")).toEqual([]);
  });

  it("is used by the client itself", () => {
    expect(networkUses(readFileSync(path.join(APP, CLIENT, "client.ts"), "utf8"))).toContain(
      "fetch",
    );
  });
});

describe("br-CONN-000008-sJpO9KMY: the renderer cannot connect", () => {
  it("has a Content Security Policy with connect-src 'none'", () => {
    const html = readFileSync(path.join(APP, "renderer", "index.html"), "utf8");
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1] ?? "";
    expect(csp.split(";").map((d) => d.trim())).toContain("connect-src 'none'");
  });

  it("gets only the Sump calls from the preload bridge, all read-only but request", async () => {
    const exposed: Record<string, unknown> = {};
    const invoked: unknown[][] = [];
    const listeners = new Map<string, (event: unknown, record: unknown) => void>();
    const electron = {
      contextBridge: {
        exposeInMainWorld: (key: string, api: unknown) => {
          exposed[key] = api;
        },
      },
      ipcRenderer: {
        invoke: async (...args: unknown[]) => {
          invoked.push(args);
          return { ok: true, value: null };
        },
        on: (channel: string, handler: (event: unknown, record: unknown) => void) => {
          listeners.set(channel, handler);
        },
        removeListener: (channel: string) => {
          listeners.delete(channel);
        },
      },
    };
    const code = readFileSync(path.join(APP, "preload.cjs"), "utf8");
    vm.runInNewContext(code, { require: (name: string) => (name === "electron" ? electron : {}) });

    expect(Object.keys(exposed)).toEqual(["correlate"]);
    const api = exposed.correlate as {
      sump: {
        active: () => Promise<unknown>;
        states: () => Promise<unknown>;
        onState: (listener: (record: unknown) => void) => () => void;
        request: (m: unknown) => Promise<unknown>;
      };
    };
    expect(Object.keys(api)).toEqual([
      "theme",
      "sump",
      "sidebar",
      "status",
      "menu",
      "picker",
      "stream",
      "logs",
    ]);
    // The log panels' choices and Export .log: only their own channels (REQ-000029-sJpO9KMY).
    const logs = (exposed.correlate as { logs: Record<string, (m?: unknown) => unknown> }).logs;
    expect(Object.keys(logs)).toEqual(["prefs", "setPrefs", "exportLog"]);
    await logs.prefs?.();
    await logs.setPrefs?.({ order: "oldest" });
    await logs.exportLog?.({ source: "self/web" });
    expect(invoked.splice(0)).toEqual([
      ["logs:prefs"],
      ["logs:setPrefs", { order: "oldest" }],
      ["logs:export", { source: "self/web" }],
    ]);
    const stream = (exposed.correlate as { stream: Record<string, (m?: unknown) => unknown> })
      .stream;
    expect(Object.keys(stream)).toEqual(["active", "setActive"]);
    await stream.active?.();
    await stream.setActive?.("self");
    expect(invoked.splice(0)).toEqual([["stream:active"], ["stream:setActive", "self"]]);
    const picker = (exposed.correlate as { picker: Record<string, (m?: unknown) => unknown> })
      .picker;
    expect(Object.keys(picker)).toEqual(["lastStream", "setLastStream"]);
    await picker.lastStream?.("local");
    await picker.setLastStream?.({ sump: "local", stream: "self" });
    expect(invoked.splice(0)).toEqual([
      ["picker:lastStream", "local"],
      ["picker:setLastStream", { sump: "local", stream: "self" }],
    ]);
    const menu = (exposed.correlate as { menu: Record<string, (m?: unknown) => unknown> }).menu;
    expect(Object.keys(menu)).toEqual(["action"]);
    await menu.action?.("zoom-in");
    expect(invoked.splice(0)).toEqual([["menu:action", "zoom-in"]]);
    const status = (exposed.correlate as { status: Record<string, (m?: unknown) => unknown> })
      .status;
    expect(Object.keys(status)).toEqual([
      "history",
      "add",
      "clear",
      "visible",
      "setVisible",
      "onNotice",
      "onVisibility",
    ]);
    await status.history?.();
    await status.add?.("hello");
    await status.clear?.();
    await status.visible?.();
    await status.setVisible?.(false);
    expect(invoked.splice(0)).toEqual([
      ["status:history"],
      ["status:add", "hello"],
      ["status:clear"],
      ["status:visible"],
      ["status:setVisible", false],
    ]);
    const stopNotice = status.onNotice?.(() => {}) as () => void;
    expect(listeners.has("status:notice")).toBe(true);
    stopNotice();
    expect(listeners.has("status:notice")).toBe(false);
    const sidebar = (
      exposed.correlate as {
        sidebar: Record<string, (m?: unknown) => unknown>;
      }
    ).sidebar;
    expect(Object.keys(sidebar)).toEqual(["get", "set", "action", "onLayout", "onRun"]);
    await sidebar.get?.();
    await sidebar.set?.({ width: 300 });
    await sidebar.action?.("about");
    expect(invoked.splice(0)).toEqual([
      ["sidebar:get"],
      ["sidebar:set", { width: 300 }],
      ["sidebar:action", "about"],
    ]);
    const runs: unknown[] = [];
    const stopRun = sidebar.onRun?.((name: unknown) => runs.push(name)) as () => void;
    listeners.get("sidebar:run")?.({}, "preferences");
    expect(runs).toEqual(["preferences"]);
    stopRun();
    expect(listeners.has("sidebar:run")).toBe(false);
    const stopLayout = sidebar.onLayout?.(() => {}) as () => void;
    expect(listeners.has("sidebar:layout")).toBe(true);
    stopLayout();
    const theme = (
      exposed.correlate as { theme: Record<string, (m?: unknown) => Promise<unknown>> }
    ).theme;
    expect(Object.keys(theme)).toEqual(["get", "set"]);
    await theme.get?.();
    await theme.set?.("dark");
    expect(invoked.splice(0)).toEqual([["theme:get"], ["theme:set", "dark"]]);
    expect(Object.keys(api.sump)).toEqual([
      "active",
      "states",
      "onState",
      "plan",
      "provisionLocal",
      "provisionRemote",
      "list",
      "rename",
      "replaceKey",
      "switchTo",
      "uninstall",
      "audit",
      "request",
    ]);
    await api.sump.active();
    expect(invoked.shift()).toEqual(["sump:active"]);
    await api.sump.states();
    expect(invoked.shift()).toEqual(["sump:states"]);
    const heard: unknown[] = [];
    const stop = api.sump.onState((record) => heard.push(record));
    listeners.get("sump:state")?.({}, { id: "local", state: "active" });
    expect(heard).toEqual([{ id: "local", state: "active" }]);
    stop();
    expect(listeners.has("sump:state")).toBe(false);
    const message = { sump: "local", method: "GET", path: "/health" };
    await expect(api.sump.request(message)).resolves.toEqual({ ok: true, value: null });
    expect(invoked).toEqual([["sump:request", message]]);
  });
});
