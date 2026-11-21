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
  [/["'](node:)?(http|https|http2|net|tls|dgram)["']/, "a Node network module"],
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
  ])("catches %s", (line, use) => {
    expect(networkUses(line)).toContain(use);
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

  it("gets only sump.request from the preload bridge, sent over sump:request", async () => {
    const exposed: Record<string, unknown> = {};
    const invoked: unknown[][] = [];
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
      },
    };
    const code = readFileSync(path.join(APP, "preload.cjs"), "utf8");
    vm.runInNewContext(code, { require: (name: string) => (name === "electron" ? electron : {}) });

    expect(Object.keys(exposed)).toEqual(["correlate"]);
    const api = exposed.correlate as { sump: { request: (m: unknown) => Promise<unknown> } };
    expect(Object.keys(api)).toEqual(["sump"]);
    expect(Object.keys(api.sump)).toEqual(["request"]);
    const message = { sump: "local", method: "GET", path: "/health" };
    await expect(api.sump.request(message)).resolves.toEqual({ ok: true, value: null });
    expect(invoked).toEqual([["sump:request", message]]);
  });
});
