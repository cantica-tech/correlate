#!/usr/bin/env node
/**
 * The app's icons (REQ-000019-sJpO9KMY): imports, cleans and generates.
 *
 * `node build/icons.js` regenerates `renderer/src/icons/icons.generated.ts`
 * from the `.svg` files in `renderer/src/icons/`. With `--import`, it first
 * writes those `.svg` files again from their sources, where they are checked
 * out next to this repository: cttc's sidebar icons and the inline SVGs of
 * its `index.html` and `action-bar.html`, named by hand after what they mean
 * (`CTTC_SHAPES`), and the correlator set
 * (`~/sources/icons/correlator`), under the names decided in
 * FEAT-000020-sJpO9KMY. `--dry-run` with `--import` prints the names only.
 *
 * Cleaning: no XML prologue, doctype, comment or editor metadata; no fixed
 * size on the root; a viewBox; fills and strokes in `currentColor` (the app
 * logo, `correlator-app`, keeps its colors); nothing active.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ICONS = path.join(APP, "renderer/src/icons");
const SOURCES = path.resolve(APP, "../../..");
const CTTC = path.join(SOURCES, "cttc/app/renderer");
const CORRELATOR = path.join(SOURCES, "icons/correlator");

/** The correlator set: file → icon name (FEAT-000020-sJpO9KMY). @type {Record<string, string>} */
const CORRELATOR_NAMES = {
  "sump.svg": "sump",
  "data-stream.svg": "data-stream",
  "stream.svg": "stream",
  "project.svg": "project",
  "track.svg": "track",
  "recordind.svg": "recordind",
  "correlator.svg": "correlator",
  "correlator-app.svg": "correlator-app",
};

/** Icons keeping their own colors. */
export const COLORED = new Set(["correlator-app"]);

/**
 * cttc's inline SVGs, by shape (the first 6 hex digits of the SHA-1 of the
 * SVG without whitespace): the name it gets here, or `null` when the
 * correlator set takes its place (FEAT-000020-sJpO9KMY). A shape not listed
 * stops the import, so every new cttc icon is named by hand.
 */
/** @type {Record<string, string | null>} */
const CTTC_SHAPES = {
  "4bacdf": null, // Gateway group: the correlator `sump`.
  "72fd1e": null, // Docker Host group: the correlator `data-stream`.
  b4603f: null, // the gateway status pill: `sump`.
  "0fda4c": null, // the Docker host status pill: `data-stream`.
  "714c41": null, // live tracking mode: the correlator `track`.
  "4bb28a": null, // Back to live tracking: `track`.
  "9f34cd": "new", // New Gateway, New Docker Host
  "36f39a": "edit", // Edit Gateway, Edit Docker Host, Edit Events
  "61f0f5": "remove", // Uninstall Gateway, Remove Docker Host
  "5f120c": "secure-storage",
  dbd425: "disconnect",
  eec2b7: "connect",
  cc7c76: "events",
  f0ee03: "create-event",
  "5507b6": "analysis",
  "2eb94c": "load-data",
  fc186c: "opened-data",
  "085132": "preferences",
  df8ccc: "analysis-mode",
  "04d6da": "analysis-mode-status-bar",
  ceaa06: "help",
  "17151a": "export",
  "33465b": "view-range",
  dcac07: "bring-back",
  "4bc2b5": "history",
  c9fdad: "set-source",
  "3b09c8": "fetch",
  "017e61": "logs",
  c68370: "transforms",
  "37972a": "preferences-window",
  "4419fe": "search",
  "3cb60d": "settings",
  "6944e1": "appearance",
  af10e4: "ship-logs",
  bdb3ff: "appearance-action",
  "4e840d": "settings-action",
};

/** The shape key of an SVG. @param {string} svg */
function shapeOf(svg) {
  return createHash("sha1").update(svg.replace(/\s+/g, "")).digest("hex").slice(0, 6);
}

/**
 * A clean SVG: see the module comment.
 * @param {string} svg
 * @param {string} name
 */
export function clean(svg, name) {
  let s = svg
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<metadata[\s\S]*?<\/metadata>/g, "")
    .replace(/<sodipodi:namedview[\s\S]*?(\/>|<\/sodipodi:namedview>)/g, "")
    .replace(/\s(?:inkscape|sodipodi):[\w-]+="[^"]*"/g, "")
    .replace(/\sxmlns:(?:inkscape|sodipodi|svg|rdf|cc|dc|xlink)="[^"]*"/g, "")
    .replace(
      /\s(?:id|data-name|enable-background|version|xml:space|class|style|x|y)="[^"]*"(?=[^<]*>)/g,
      (m) => (/\sstyle="/.test(m) ? m : m.startsWith(" id=") && COLORED.has(name) ? m : ""),
    );
  // Illustrator's `enable-background` is no CSS property; drop it, and any style left empty.
  s = s.replace(/enable-background\s*:[^;"]*;?/g, "").replace(/\sstyle="\s*"/g, "");
  if (!COLORED.has(name)) {
    s = s
      .replace(/\s(fill|stroke)="(?!none")[^"]*"/g, ' $1="currentColor"')
      .replace(/(fill|stroke)\s*:\s*(?!none)[^;"]+/g, "$1:currentColor")
      .replace(/\sstop-color="[^"]*"/g, ' stop-color="currentColor"');
  }
  s = s.replace(/<svg\b([^>]*)>/, (_m, attrs) => {
    let a = attrs
      .replace(/\s(width|height)="[^"]*"/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!/\bviewBox=/.test(a)) throw new Error(`${name}: no viewBox`);
    if (!COLORED.has(name) && !/\bfill=/.test(a)) a += ' fill="currentColor"';
    if (!/\bxmlns=/.test(a)) a = `xmlns="http://www.w3.org/2000/svg" ${a}`;
    if (!/aria-hidden/.test(a)) a += ' aria-hidden="true"';
    return `<svg ${a}>`;
  });
  return `${s
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim()}\n`;
}

/** cttc's inline SVGs with the action each belongs to. */
function cttcInline() {
  const found = [];
  for (const file of ["index.html", "action-bar.html"]) {
    const html = readFileSync(path.join(CTTC, file), "utf8");
    for (const m of html.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/g)) {
      const before = html.slice(Math.max(0, (m.index ?? 0) - 400), m.index);
      const after = html.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 120);
      const action = [...before.matchAll(/data-action="([^"]+)"/g)].pop()?.[1];
      const idAttr = [...before.matchAll(/\sid="([^"]+)"/g)].pop()?.[1];
      const text =
        after
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .split(/\s{2,}|<|\n/)[0] ?? "";
      const label =
        text && text.length < 40 && !/^</.test(text) ? text : (action ?? idAttr ?? "icon");
      found.push({ svg: m[0], label, where: `cttc app/renderer/${file}`, action, id: idAttr });
    }
  }
  return found;
}

/** Where cttc's "Current Status" icon lives. */
const CLIPBOARD_WHERE = "cttc app/renderer/src/shared/toolbar-pills/index.ts (CLIPBOARD_ICON_SVG)";

/** cttc's `CLIPBOARD_ICON_SVG`, the pills' "Current Status" icon, if found. */
export function cttcClipboard() {
  const file = path.join(CTTC, "src/shared/toolbar-pills/index.ts");
  if (!existsSync(file)) return undefined;
  const m = readFileSync(file, "utf8").match(/CLIPBOARD_ICON_SVG =\s*'(<svg[\s\S]*?<\/svg>)'/);
  return m?.[1];
}

/** @param {boolean} dryRun */
function importAll(dryRun) {
  if (!existsSync(CTTC) || !existsSync(CORRELATOR)) {
    throw new Error(`--import needs ${CTTC} and ${CORRELATOR} checked out`);
  }
  /** @type {Record<string, string>} */
  const sources = {};
  const seen = new Map();
  /** @param {string} name @param {string} svg @param {string} where */
  const write = (name, svg, where) => {
    const body = clean(svg, name);
    const hash = createHash("sha256").update(body).digest("hex");
    if (seen.has(hash) || sources[name]) return;
    seen.set(hash, name);
    sources[name] = where;
    if (!dryRun) writeFileSync(path.join(ICONS, `${name}.svg`), body);
  };
  for (const [file, name] of Object.entries(CORRELATOR_NAMES)) {
    write(name, readFileSync(path.join(CORRELATOR, file), "utf8"), `icons/correlator/${file}`);
  }
  for (const file of readdirSync(path.join(CTTC, "assets/sidebar")).filter((f) =>
    f.endsWith(".svg"),
  )) {
    write(
      `sidebar-${file.replace(/\.svg$/, "")}`,
      readFileSync(path.join(CTTC, "assets/sidebar", file), "utf8"),
      `cttc app/renderer/assets/sidebar/${file}`,
    );
  }
  for (const icon of cttcInline()) {
    const shape = shapeOf(icon.svg);
    if (!(shape in CTTC_SHAPES)) {
      throw new Error(
        `a cttc icon not named yet (${shape}, near "${icon.label}" in ${icon.where}): add it to CTTC_SHAPES`,
      );
    }
    const name = CTTC_SHAPES[shape];
    if (name) write(name, icon.svg, `${icon.where} (${icon.label})`);
  }
  // The pills' "Current Status" entry: raw markup in cttc's code, not in a page.
  const clipboard = cttcClipboard();
  if (clipboard) write("current-status", clipboard, CLIPBOARD_WHERE);
  if (dryRun) {
    for (const [name, where] of Object.entries(sources)) console.log(`${name.padEnd(28)} ${where}`);
    return;
  }
  writeFileSync(path.join(ICONS, "sources.json"), `${JSON.stringify(sources, null, 2)}\n`);
}

/** `icons.generated.ts` from the `.svg` files. */
export function generated() {
  const names = readdirSync(ICONS)
    .filter((f) => f.endsWith(".svg"))
    .map((f) => f.replace(/\.svg$/, ""))
    .sort();
  const lines = names.map(
    (n) =>
      `  ${JSON.stringify(n)}: ${JSON.stringify(readFileSync(path.join(ICONS, `${n}.svg`), "utf8").trim())},`,
  );
  return [
    "// Generated by build/icons.js from the .svg files in this folder; do not edit.",
    "// REQ-000019-sJpO9KMY: regenerate with `npm run icons`.",
    "export const ICONS = {",
    ...lines,
    "} as const;",
    "",
    "/** The name of an icon in the set. */",
    "export type IconName = keyof typeof ICONS;",
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--import")) importAll(args.includes("--dry-run"));
  if (!args.includes("--dry-run"))
    writeFileSync(path.join(ICONS, "icons.generated.ts"), generated());
}
