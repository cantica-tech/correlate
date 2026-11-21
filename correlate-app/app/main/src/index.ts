/**
 * What `main.cjs` loads from the TypeScript side of the main process,
 * bundled to `main/dist/main.cjs` by `build/build-main.js`.
 *
 * Until the Sump catalog arrives (Phase 3 of
 * `docs/roadmap/correlate-app-rewrite.md`), the app knows one Sump, "local",
 * at `CORRELATE_SUMP_URL` or the Sump's default `http://127.0.0.1:8765`.
 */
import type { Sump } from "./sump/errors.js";
import type { SumpResolver } from "./sump/ipc.js";

export { registerSumpIpc } from "./sump/ipc.js";

/** The Sump's default address (server/src/correlate_sump/__main__.py). */
export const DEFAULT_SUMP_URL = "http://127.0.0.1:8765";

/** The Sumps the app knows, from the environment for now. */
export function configuredSumps(env: Record<string, string | undefined>): SumpResolver {
  const local: Sump = { name: "local", baseUrl: env.CORRELATE_SUMP_URL || DEFAULT_SUMP_URL };
  new URL(local.baseUrl); // An invalid URL stops the app at startup, not at the first call.
  return (name) => (name === local.name ? local : undefined);
}
