#!/usr/bin/env node
/**
 * Bundles the main process's TypeScript (`main/src/index.ts`) into
 * `main/dist/main.cjs`, which `main.cjs` requires. Electron stays external:
 * it is provided at run time. Pass `--watch` to rebuild on every change.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const watch = process.argv.includes("--watch");

/**
 * esbuild options: one CommonJS bundle for Node, as `main.cjs` is CommonJS.
 * @type {import("esbuild").BuildOptions}
 */
const options = {
  entryPoints: [path.join(ROOT, "main/src/index.ts")],
  outfile: path.join(ROOT, "main/dist/main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
};

/** Build once, or watch and rebuild until interrupted. */
async function main() {
  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    console.log("[build-main] watching for changes...");
  } else {
    await build(options);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
