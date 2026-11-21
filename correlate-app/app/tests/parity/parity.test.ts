/**
 * Visual parity of the component primitives with cttc
 * (br-STYLE-000001-sJpO9KMY, REQ-000020-sJpO9KMY Requirement 2), as decided
 * in FEAT-000021-sJpO9KMY: Electron renders each fixture from cttc's own
 * markup under cttc's own `style.css` (`page/cttc.html`) and from our
 * components under our CSS (`page/ours.tsx`), in light and dark, and the two
 * pictures are compared pixel by pixel.
 *
 * macOS only: fonts and anti-aliasing differ between systems, and cttc's
 * references are macOS captures. On a failure the three pictures are written
 * to `out/`.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPONENT_LIMIT, compare, type Mask, readPng, writePng } from "./compare.js";
import { cttcChartBlock, cttcSwatchScript } from "./cttcCharts.js";
import { cttcMenuBar } from "./cttcMenuBar.js";
import { cttcSidebar, cttcWidthScript } from "./cttcSidebar.js";
import { cttcPillMenu, cttcStatusBar } from "./cttcStatusBar.js";
import { cttcRemoveDialog, cttcStreamsDialog } from "./cttcStreams.js";
import { SIDEBAR_CASES } from "./page/sidebar-cases.js";
import { ARRIVING, HISTORY, STATUSBAR_CASES } from "./page/statusbar-data.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");

/** The fixtures of both pages. */
const FIXTURES = [
  "button-default",
  "button-primary",
  "button-danger",
  "button-disabled",
  "button-fetch",
  "seg-control",
  "switch",
  "panel",
] as const;

/**
 * Intended differences from cttc, each with its reason: a fixture listed
 * here is masked or allowed more. None so far.
 */
const INTENDED: Partial<Record<string, { masks?: Mask[]; limit?: number; reason: string }>> = {};

const THEMES = ["light", "dark"] as const;

let app: ElectronApplication | undefined;
let page: Page;

/** Bundle our side of the parity checks into `dist/`. */
async function buildOurs(): Promise<void> {
  await build({
    entryPoints: [
      path.join(here, "page/ours.tsx"),
      path.join(here, "page/ours-sidebar.tsx"),
      path.join(here, "page/ours-statusbar.tsx"),
      path.join(here, "page/ours-menubar.tsx"),
      path.join(here, "page/ours-streams.tsx"),
      path.join(here, "page/ours-remove.tsx"),
      path.join(here, "page/ours-charts.tsx"),
    ],
    outdir: path.join(here, "dist"),
    bundle: true,
    format: "iife",
    jsx: "automatic",
    jsxImportSource: "react",
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
  });
}

async function show(side: "cttc" | "ours", theme: (typeof THEMES)[number]): Promise<void> {
  // Playwright fixes the page's color scheme itself, so it is set here, not
  // through Electron's nativeTheme.
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(pathToFileURL(path.join(here, `page/${side}.html`)).href);
  await page.waitForSelector('[data-fixture="panel"]');
  await page.evaluate("document.fonts.ready.then(() => true)");
  const dark = await page.evaluate('matchMedia("(prefers-color-scheme: dark)").matches');
  expect(dark).toBe(theme === "dark");
}

async function shoot(selector: string): Promise<Buffer> {
  return page.locator(selector).screenshot({ animations: "disabled", caret: "hide" });
}

async function openDialog(side: "cttc" | "ours"): Promise<void> {
  if (side === "cttc") {
    await page.evaluate('document.getElementById("dlg-fixture").showModal()');
  } else {
    await page.evaluate("window.parity.openDialog()");
  }
  await page.waitForSelector("#dlg-fixture[open]");
}

/** Every picture of one side, by name. */
async function capture(side: "cttc" | "ours"): Promise<Map<string, Buffer>> {
  const pictures = new Map<string, Buffer>();
  for (const theme of THEMES) {
    await show(side, theme);
    for (const name of FIXTURES) {
      pictures.set(`${name}-${theme}`, await shoot(`[data-fixture="${name}"]`));
    }
    await openDialog(side);
    pictures.set(`dialog-${theme}`, await shoot("#dlg-fixture"));
    pictures.set(
      `dialog-page-${theme}`,
      await page.screenshot({ animations: "disabled", caret: "hide" }),
    );
  }
  return pictures;
}

/**
 * The sidebar in each of its cases (REQ-000021-sJpO9KMY Requirement 5): on
 * cttc's page, cttc's markup for the case written into the stage; on ours,
 * our sidebar for it.
 */
async function captureSidebar(side: "cttc" | "ours", pictures: Map<string, Buffer>): Promise<void> {
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [name, { layout, detached }] of Object.entries(SIDEBAR_CASES)) {
      if (side === "cttc") {
        await page.goto(pathToFileURL(path.join(here, "page/cttc-sidebar.html")).href);
        const aside = cttcSidebar(layout, detached);
        const html = detached
          ? aside
          : `<div id="app-body" data-dock="${layout.dock}">${aside}<div id="action-bar-splitter"></div><div id="main-content"></div></div>`;
        await page.evaluate(
          `(() => { const s = document.getElementById("stage"); s.className = ${JSON.stringify(detached ? "detached" : "")}; s.innerHTML = ${JSON.stringify(html)}; ${cttcWidthScript(layout, detached)} })()`,
        );
      } else {
        const url = pathToFileURL(path.join(here, "page/ours-sidebar.html"));
        url.searchParams.set("case", name);
        await page.goto(url.href);
      }
      await page.waitForSelector("#action-bar");
      await page.evaluate("document.fonts.ready.then(() => true)");
      pictures.set(`sidebar-${name}-${theme}`, await shoot("#stage"));
    }
  }
}

/**
 * The status bar with each thing open (REQ-000022-sJpO9KMY Requirement 5):
 * on cttc's page, cttc's markup for it written into the stage; on ours, our
 * bar, opened by clicking as a user would. The context menu is compared on
 * its own, wherever it opens.
 */
async function captureStatusBar(
  side: "cttc" | "ours",
  pictures: Map<string, Buffer>,
): Promise<void> {
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    for (const name of STATUSBAR_CASES) {
      await page.goto(pathToFileURL(path.join(here, `page/${side}-statusbar.html`)).href);
      if (side === "cttc") {
        const times: Record<string, string> = {};
        for (const n of [...HISTORY, ARRIVING]) {
          times[n.at] = String(
            await page.evaluate(`new Date(${JSON.stringify(n.at)}).toLocaleTimeString()`),
          );
        }
        await page.evaluate(
          `document.getElementById("stage").innerHTML = ${JSON.stringify(cttcStatusBar(name, times))}`,
        );
        if (name === "menu") {
          await page.evaluate(
            `(() => { document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(cttcPillMenu())}); document.querySelector("#ctxmenu button:not(:disabled)").focus(); })()`,
          );
        }
      } else {
        await page.waitForSelector("#server-status");
        await page.waitForFunction(
          () =>
            (
              globalThis as unknown as {
                document: { getElementById(id: string): { textContent: string } | null };
              }
            ).document.getElementById("app-status-bar-text")?.textContent !== "",
        );
        if (name === "switcher") {
          await page.click("#server-status-btn");
          await page.waitForSelector(".gateway-item");
        } else if (name === "menu") {
          await page.click("#server-status-btn", { button: "right" });
          await page.waitForSelector("#ctxmenu");
        } else if (name === "status") {
          await page.click("#server-status-btn", { button: "right" });
          await page.click('#ctxmenu button:has-text("Current Status")');
          await page.waitForSelector("#connection-info-popup");
        } else if (name === "history") {
          await page.click("#status-bar-history-btn");
          await page.waitForSelector(".status-bar-history-row");
        }
        // Away from anything it would light up on hover.
        await page.mouse.move(1, 1);
      }
      await page.evaluate("document.fonts.ready.then(() => true)");
      pictures.set(
        `statusbar-${name}-${theme}`,
        await shoot(name === "menu" ? "#ctxmenu" : "#stage"),
      );
    }
  }
}

/** The menu bar's cases: closed, then each menu open. */
const MENUBAR_CASES = ["closed", "file", "edit", "view", "window", "help"] as const;

/**
 * The menu bar, closed and with each menu open (REQ-000023-sJpO9KMY
 * Requirement 5): on cttc's page, cttc's markup with that menu `.open`; on
 * ours, our bar, the menu opened by clicking its label. Shortcuts as on
 * macOS, where this runs.
 */
async function captureMenuBar(side: "cttc" | "ours", pictures: Map<string, Buffer>): Promise<void> {
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    for (const name of MENUBAR_CASES) {
      await page.goto(pathToFileURL(path.join(here, `page/${side}-menubar.html`)).href);
      if (side === "cttc") {
        const open = name === "closed" ? null : name;
        await page.evaluate(
          `document.getElementById("stage").innerHTML = ${JSON.stringify(cttcMenuBar(open, true))}`,
        );
      } else {
        await page.waitForSelector("#menubar");
        if (name !== "closed") {
          await page.click(`[data-menu="${name}"] .menu-label`);
          await page.waitForSelector(`[data-menu="${name}"].open`);
        }
        // Away from the bar, so no label is lit up by hover.
        await page.mouse.move(590, 310);
      }
      await page.evaluate("document.fonts.ready.then(() => true)");
      pictures.set(`menubar-${name}-${theme}`, await shoot("#stage"));
    }
  }
}

/**
 * The picker, opened as Edit after its fetch (REQ-000025-sJpO9KMY
 * Requirement 5): on cttc's page, cttc's `#dlg-set` written in and opened;
 * on ours, our dialog on a bridge answering with fixed data.
 */
async function captureStreams(side: "cttc" | "ours", pictures: Map<string, Buffer>): Promise<void> {
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(pathToFileURL(path.join(here, `page/${side}-streams.html`)).href);
    if (side === "cttc") {
      await page.evaluate(
        `(() => { document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(cttcStreamsDialog())}); document.getElementById("dlg-set").showModal(); })()`,
      );
    }
    await page.waitForSelector("#dlg-set[open] #docker-targets label.unavailable");
    // No field or button lit up by focus or hover: the same on both pages.
    await page.evaluate("document.activeElement?.blur()");
    await page.mouse.move(1, 1);
    await page.evaluate("document.fonts.ready.then(() => true)");
    pictures.set(`streams-dialog-${theme}`, await shoot("#dlg-set"));
  }
}

/** The Remove dialog, open, nothing picked (REQ-000027-sJpO9KMY Requirement 5). */
async function captureRemove(side: "cttc" | "ours", pictures: Map<string, Buffer>): Promise<void> {
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(pathToFileURL(path.join(here, `page/${side}-remove.html`)).href);
    if (side === "cttc") {
      await page.evaluate(
        `(() => { document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(cttcRemoveDialog())}); document.getElementById("dlg-remove-daemon").showModal(); })()`,
      );
    }
    await page.waitForSelector('#dlg-remove-daemon[open] option[value="ssh:ops@lab:22"]', {
      state: "attached",
    });
    await page.evaluate("document.activeElement?.blur()");
    await page.mouse.move(1, 1);
    await page.evaluate("document.fonts.ready.then(() => true)");
    pictures.set(`remove-dialog-${theme}`, await shoot("#dlg-remove-daemon"));
  }
}

/**
 * The charts' head and legend (REQ-000028-sJpO9KMY Requirement 4): on cttc's
 * page, cttc's chart block with its swatches colored by script; on ours, our
 * ChartBlock on fixed data. The strips' drawing is the ported
 * `drawChartStrip`, tested on its own, so it is not compared here.
 */
async function captureCharts(side: "cttc" | "ours", pictures: Map<string, Buffer>): Promise<void> {
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(pathToFileURL(path.join(here, `page/${side}-charts.html`)).href);
    if (side === "cttc") {
      await page.evaluate(
        `(() => { document.getElementById("stage").innerHTML = ${JSON.stringify(cttcChartBlock())}; ${cttcSwatchScript()} })()`,
      );
    }
    await page.waitForSelector("#legend .legend-item:nth-child(2)");
    await page.mouse.move(1, 1);
    await page.evaluate("document.fonts.ready.then(() => true)");
    pictures.set(`charts-head-${theme}`, await shoot("#chart-head"));
    pictures.set(`charts-legend-${theme}`, await shoot("#legend"));
  }
}

let cttc: Map<string, Buffer>;
let ours: Map<string, Buffer>;

describe.skipIf(process.platform !== "darwin")(
  "br-STYLE-000001-sJpO9KMY: visual parity with cttc",
  () => {
    beforeAll(async () => {
      rmSync(out, { recursive: true, force: true });
      await buildOurs();
      const env = { ...process.env } as Record<string, string>;
      delete env.ELECTRON_RUN_AS_NODE;
      app = await _electron.launch({
        executablePath: createRequire(import.meta.url)("electron") as string,
        args: [path.join(here, "harness/main.cjs")],
        env,
      });
      page = await app.firstWindow();
      cttc = await capture("cttc");
      ours = await capture("ours");
      await captureSidebar("cttc", cttc);
      await captureSidebar("ours", ours);
      await captureStatusBar("cttc", cttc);
      await captureStatusBar("ours", ours);
      await captureMenuBar("cttc", cttc);
      await captureMenuBar("ours", ours);
      await captureStreams("cttc", cttc);
      await captureStreams("ours", ours);
      await captureRemove("cttc", cttc);
      await captureRemove("ours", ours);
      await captureCharts("cttc", cttc);
      await captureCharts("ours", ours);
    }, 120_000);

    afterAll(async () => {
      await app?.close();
    });

    const names = [
      ...FIXTURES,
      "dialog",
      "dialog-page",
      ...Object.keys(SIDEBAR_CASES).map((c) => `sidebar-${c}`),
      ...STATUSBAR_CASES.map((c) => `statusbar-${c}`),
      ...MENUBAR_CASES.map((c) => `menubar-${c}`),
      "streams-dialog",
      "remove-dialog",
      "charts-head",
      "charts-legend",
    ].flatMap((n) => THEMES.map((t) => `${n}-${t}`));

    it.each(names)("%s looks as in cttc", (name) => {
      const expected = cttc.get(name);
      const actual = ours.get(name);
      if (!expected || !actual) throw new Error(`no picture of ${name}`);
      const intended = INTENDED[name.replace(/-(light|dark)$/, "")];
      const result = compare(
        readPng(expected),
        readPng(actual),
        intended?.limit ?? COMPONENT_LIMIT,
        intended?.masks,
      );
      if (!result.ok) {
        mkdirSync(out, { recursive: true });
        writeFileSync(path.join(out, `${name}-cttc.png`), expected);
        writeFileSync(path.join(out, `${name}-ours.png`), actual);
        if (result.diff) writeFileSync(path.join(out, `${name}-diff.png`), writePng(result.diff));
      }
      expect(result.ok, `${name}: ${result.reason}; pictures in tests/parity/out/`).toBe(true);
    });
  },
);

describe.skipIf(process.platform !== "darwin")(
  "br-STYLE-000001-sJpO9KMY: the dialog's behavior",
  () => {
    it("closes on Escape and tells its owner; a click on the backdrop does nothing", async () => {
      const env = { ...process.env } as Record<string, string>;
      delete env.ELECTRON_RUN_AS_NODE;
      const electron = await _electron.launch({
        executablePath: createRequire(import.meta.url)("electron") as string,
        args: [path.join(here, "harness/main.cjs")],
        env,
      });
      try {
        const p = await electron.firstWindow();
        await p.goto(pathToFileURL(path.join(here, "page/ours.html")).href);
        await p.waitForSelector('[data-fixture="panel"]');
        await p.evaluate("window.parity.openDialog()");
        await p.waitForSelector("#dlg-fixture[open]");
        // Focus moved inside, onto the first button.
        expect(await p.evaluate("document.activeElement?.textContent")).toBe("Close");
        await p.mouse.click(5, 5);
        expect(await p.evaluate('document.getElementById("dlg-fixture").open')).toBe(true);
        await p.keyboard.press("Escape");
        await p.waitForSelector("#dlg-fixture:not([open])", { state: "attached" });
        // The close event comes after the dialog closes.
        await p.waitForFunction(
          () => (globalThis as unknown as { parity: { closes: number } }).parity.closes === 1,
          undefined,
          { timeout: 5_000 },
        );
        expect(await p.evaluate("window.parity.closes")).toBe(1);
        // It opens again after a close.
        await p.evaluate("window.parity.openDialog()");
        await p.waitForSelector("#dlg-fixture[open]");
      } finally {
        await electron.close();
      }
    }, 60_000);
  },
);
