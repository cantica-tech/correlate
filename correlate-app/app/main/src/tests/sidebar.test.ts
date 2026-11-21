import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkChange,
  type DetachedWindow,
  defaultLayout,
  readLayout,
  registerSidebarIpc,
  SIDEBAR_ACTION_CHANNEL,
  SIDEBAR_ACTIONS,
  SIDEBAR_GET_CHANNEL,
  SIDEBAR_LAYOUT_EVENT,
  SIDEBAR_RUN_EVENT,
  SIDEBAR_SET_CHANNEL,
  SidebarHost,
} from "../sidebar.js";
import { Settings } from "../theme.js";

// REQ-000021-sJpO9KMY Requirements 2 to 4: the sidebar's layout, remembered
// and shared, its detached window, and its actions.

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sidebar-test-"));
  file = path.join(dir, "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const quiet = { info: () => {}, warn: () => {} };

/** Windows that record what the host does with them. */
function fakeWindows() {
  const sent: [string, string, unknown][] = [];
  const opened: (DetachedWindow & { closed: boolean; focused: number; userCloses(): void })[] = [];
  return {
    sent,
    opened,
    broadcast: (channel: string, value: unknown) => void sent.push(["all", channel, value]),
    sendToMain: (channel: string, value: unknown) => void sent.push(["main", channel, value]),
    openDetached() {
      let listener = () => {};
      const window = {
        closed: false,
        focused: 0,
        close() {
          if (window.closed) return;
          window.closed = true;
          listener();
        },
        focus() {
          window.focused += 1;
        },
        onClosed(l: () => void) {
          listener = l;
        },
        userCloses() {
          window.close();
        },
      };
      opened.push(window);
      return window;
    },
  };
}

function host(windows = fakeWindows(), actions = { quit: () => {}, about: () => {} }) {
  return { windows, host: new SidebarHost(new Settings(file, quiet), windows, actions, quiet) };
}

describe("REQ-000021-sJpO9KMY: the layout", () => {
  it("starts docked left, 210 px wide, open, every section closed", () => {
    expect(host().host.layout()).toEqual({
      dock: "left",
      lastDock: "left",
      width: 210,
      collapsed: false,
      expanded: { sump: false, projects: false, events: false },
    });
  });

  it.each([
    [{ dock: "top" }, /left, right or detached/],
    [{ lastDock: "detached" }, /left or right/],
    [{ width: 119 }, /120 to 480/],
    [{ width: 481 }, /120 to 480/],
    [{ width: 200.5 }, /whole number/],
    [{ collapsed: "yes" }, /true or false/],
    [{ expanded: { gateway: true } }, /no section gateway/],
    [{ expanded: { sump: 1 } }, /expanded.sump/],
    [{ colour: "red" }, /no layout setting colour/],
    ["left", /an object/],
  ])("refuses %j", (change, why) => {
    expect(() => checkChange(change)).toThrow(why);
  });

  it("is remembered beside the theme, and the theme beside it", () => {
    const { host: h } = host();
    h.set({ dock: "right", width: 300, expanded: { events: true } });
    const settings = new Settings(file, quiet);
    settings.setThemeMode("dark");
    expect(readLayout(new Settings(file, quiet))).toEqual({
      ...defaultLayout(),
      dock: "right",
      lastDock: "right",
      width: 300,
      expanded: { sump: false, projects: false, events: true },
    });
    expect(JSON.parse(readFileSync(file, "utf8")).themeMode).toBe("dark");
  });

  it("keeps the defaults for what is unreadable, and says so", () => {
    writeFileSync(
      file,
      JSON.stringify({ themeMode: "light", sidebar: { dock: "top", width: 250 } }),
    );
    const warnings: string[] = [];
    const layout = readLayout(new Settings(file, quiet), { warn: (m) => warnings.push(m) });
    expect(layout).toMatchObject({ dock: "left", width: 250 });
    expect(warnings).toEqual([
      "settings: sidebar dock is left, right or detached; using the default",
    ]);
    writeFileSync(file, JSON.stringify({ sidebar: [] }));
    expect(readLayout(new Settings(file, quiet), quiet)).toEqual(defaultLayout());
  });

  it("sends every change to every window", () => {
    const { host: h, windows } = host();
    h.set({ collapsed: true });
    expect(windows.sent).toEqual([
      ["all", SIDEBAR_LAYOUT_EVENT, { ...defaultLayout(), collapsed: true }],
    ]);
  });
});

describe("REQ-000021-sJpO9KMY: detaching", () => {
  it("opens its own window when detached and closes it when docked back, where it was", () => {
    const { host: h, windows } = host();
    h.set({ dock: "right" });
    h.set({ dock: "detached" });
    expect(windows.opened).toHaveLength(1);
    expect(h.layout()).toMatchObject({ dock: "detached", lastDock: "right" });
    // Detaching again only raises the window.
    h.set({ dock: "detached" });
    expect(windows.opened).toHaveLength(1);
    expect(windows.opened[0]?.focused).toBe(1);
    // A change from inside it does not raise it.
    h.set({ expanded: { sump: true } });
    expect(windows.opened[0]?.focused).toBe(1);
    h.set({ dock: h.layout().lastDock });
    expect(windows.opened[0]?.closed).toBe(true);
    expect(h.layout().dock).toBe("right");
  });

  it("docks back where it was when the user closes the detached window", () => {
    const { host: h, windows } = host();
    h.set({ dock: "detached" });
    windows.opened[0]?.userCloses();
    expect(h.layout().dock).toBe("left");
    expect(new Settings(file, quiet).part("sidebar")).toMatchObject({ dock: "left" });
  });

  it("stays detached across a quit, and opens detached at the next start", () => {
    const first = host();
    first.host.set({ dock: "detached" });
    first.host.shutDown();
    expect(first.windows.opened[0]?.closed).toBe(true);
    expect(first.host.layout().dock).toBe("detached");
    const next = host();
    expect(next.windows.opened).toHaveLength(0);
    next.host.start();
    expect(next.windows.opened).toHaveLength(1);
  });
});

describe("REQ-000021-sJpO9KMY: actions", () => {
  it("quits and shows About here, and runs the rest in the main window", () => {
    const ran: string[] = [];
    const { host: h, windows } = host(fakeWindows(), {
      quit: () => ran.push("quit"),
      about: () => ran.push("about"),
    });
    h.action("quit");
    h.action("about");
    h.action("preferences");
    expect(ran).toEqual(["quit", "about"]);
    expect(windows.sent).toEqual([["main", SIDEBAR_RUN_EVENT, "preferences"]]);
  });

  it("refuses an action it does not know", () => {
    expect(() => host().host.action("rm -rf")).toThrow(/no sidebar action "rm -rf"/);
  });

  it("knows each entry's action once", () => {
    expect(new Set(SIDEBAR_ACTIONS).size).toBe(SIDEBAR_ACTIONS.length);
  });
});

describe("REQ-000021-sJpO9KMY: the bridge", () => {
  it("answers get, set and action, a refusal as { ok: false }", async () => {
    const handlers = new Map<string, (event: unknown, message: unknown) => unknown>();
    const { host: h } = host();
    registerSidebarIpc({ handle: (c, f) => void handlers.set(c, f as never) }, h);
    const call = (c: string, m?: unknown) =>
      (handlers.get(c) as (e: unknown, m: unknown) => unknown)({}, m);
    expect(await call(SIDEBAR_GET_CHANNEL)).toEqual(defaultLayout());
    expect(await call(SIDEBAR_SET_CHANNEL, { width: 250 })).toMatchObject({
      ok: true,
      layout: { width: 250 },
    });
    expect(await call(SIDEBAR_SET_CHANNEL, { width: 9 })).toEqual({
      ok: false,
      message: "width is a whole number from 120 to 480",
    });
    expect(await call(SIDEBAR_ACTION_CHANNEL, "preferences")).toEqual({ ok: true });
    expect(await call(SIDEBAR_ACTION_CHANNEL, "nope")).toMatchObject({ ok: false });
  });
});
