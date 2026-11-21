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
    entryPoints: [path.join(here, "page/ours.tsx")],
    outfile: path.join(here, "dist/ours.js"),
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
    }, 120_000);

    afterAll(async () => {
      await app?.close();
    });

    const names = [...FIXTURES, "dialog", "dialog-page"].flatMap((n) =>
      THEMES.map((t) => `${n}-${t}`),
    );

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
