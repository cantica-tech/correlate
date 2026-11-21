/**
 * What `main.cjs` loads from the TypeScript side of the main process,
 * bundled to `main/dist/main.cjs` by `build/build-main.js`.
 *
 * Until the Sump catalog arrives (Phase 3 of
 * `docs/roadmap/correlate-app-rewrite.md`), the app knows one Sump, "local",
 * at `CORRELATE_SUMP_URL` or the Sump's default `http://127.0.0.1:8765`.
 *
 * The key vault (REQ-000008-sJpO9KMY) lives in the app's user-data folder,
 * under `vault/`.
 */
import path from "node:path";
import type { Sump } from "./sump/errors.js";
import type { SumpResolver } from "./sump/ipc.js";
import type { SafeStorageLike } from "./vault/cipher.js";
import { Vault, type VaultLogger } from "./vault/vault.js";

export { registerSumpIpc } from "./sump/ipc.js";

/** The Sump's default address (server/src/correlate_sump/__main__.py). */
export const DEFAULT_SUMP_URL = "http://127.0.0.1:8765";

/** The Sumps the app knows, from the environment for now. */
export function configuredSumps(env: Record<string, string | undefined>): SumpResolver {
  const local: Sump = { name: "local", baseUrl: env.CORRELATE_SUMP_URL || DEFAULT_SUMP_URL };
  new URL(local.baseUrl); // An invalid URL stops the app at startup, not at the first call.
  return (name) => (name === local.name ? local : undefined);
}

/**
 * Open the vault in `userData/vault`. Only its metadata is read: safe
 * storage (the keychain) is not touched until a key is stored or read. A
 * corrupt vault is reported and left as is; the app then runs without one.
 */
export function openVault(
  userData: string,
  safeStorage: SafeStorageLike,
  logger: VaultLogger = console,
): Vault | undefined {
  try {
    return new Vault(path.join(userData, "vault"), safeStorage, { logger });
  } catch (error) {
    logger.warn(`vault not opened: ${(error as Error).message}`);
    return undefined;
  }
}
