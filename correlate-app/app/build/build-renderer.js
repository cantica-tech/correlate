#!/usr/bin/env node
/**
 * Bundles `renderer/src/entry.tsx` into `renderer/dist/bundle.js` for the
 * Electron window to load. Pass `--watch` to rebuild on every change.
 * Same esbuild shape as correlator's `build/build-renderer.js`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const watch = process.argv.includes("--watch");

/**
 * esbuild options: one IIFE bundle with the automatic React JSX runtime.
 * @type {import("esbuild").BuildOptions}
 */
const options = {
  entryPoints: [path.join(ROOT, "renderer/src/entry.tsx")],
  outfile: path.join(ROOT, "renderer/dist/bundle.js"),
  bundle: true,
  format: "iife",
  jsx: "automatic",
  jsxImportSource: "react",
  sourcemap: true,
  logLevel: "info",
};

/** Build once, or watch and rebuild until interrupted. */
async function main() {
  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    console.log("[build-renderer] watching for changes...");
  } else {
    await build(options);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
