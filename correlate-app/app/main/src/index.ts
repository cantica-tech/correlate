/**
 * What `main.cjs` loads from the TypeScript side of the main process,
 * bundled to `main/dist/main.cjs` by `build/build-main.js`.
 *
 * Until the Sump catalog arrives (Phase 3 of
 * `docs/roadmap/correlate-app-rewrite.md`), the app knows one Sump, "local",
 * at `CORRELATE_SUMP_URL` or the Sump's default `http://127.0.0.1:8765`.
 *
 * The key vault (REQ-000008-sJpO9KMY) lives in the app's user-data folder,
 * under `vault/`; it holds the user's identity key, which logs in to Sumps
 * (REQ-000011-sJpO9KMY).
 */
import path from "node:path";
import { ensureIdentity, userName } from "./identity/identity.js";
import type { Sump } from "./sump/errors.js";
import type { Relogin, SumpResolver } from "./sump/ipc.js";
import { login } from "./sump/login.js";
import { SessionTokens } from "./sump/tokens.js";
import type { SafeStorageLike } from "./vault/cipher.js";
import { Vault, type VaultLogger } from "./vault/vault.js";

export { identityPublicKey, importIdentity, userName } from "./identity/identity.js";
export { logout } from "./sump/client.js";
export { registerSumpIpc } from "./sump/ipc.js";
export { login } from "./sump/login.js";
export { SessionTokens };

/** The Sump's default address (server/src/correlate_sump/__main__.py). */
export const DEFAULT_SUMP_URL = "http://127.0.0.1:8765";

/**
 * The Sumps the app knows, from the environment for now, each with its
 * session token from `tokens` at the time of the call. Until the SSH-key
 * login (Item 12), `CORRELATE_SUMP_TOKEN` gives the local Sump a token, for
 * development; it stays in memory like any other.
 */
export function configuredSumps(
  env: Record<string, string | undefined>,
  tokens: SessionTokens = new SessionTokens(),
): SumpResolver {
  const local: Sump = { name: "local", baseUrl: env.CORRELATE_SUMP_URL || DEFAULT_SUMP_URL };
  new URL(local.baseUrl); // An invalid URL stops the app at startup, not at the first call.
  if (env.CORRELATE_SUMP_TOKEN) tokens.set(local.name, env.CORRELATE_SUMP_TOKEN);
  return (name) => {
    if (name !== local.name) return undefined;
    const token = tokens.get(name);
    return token ? { ...local, token } : { ...local };
  };
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

/**
 * How the main process logs in again when a Sump refuses its token: the
 * identity key from the vault (generated the first time), the user name from
 * `userName`. A vault that does not exist yet is created when it needs no
 * passphrase; a locked one, or none, means the user must act (Phase 4).
 */
export function reloginWith(
  vault: Vault | undefined,
  resolve: SumpResolver,
  tokens: SessionTokens,
  env: Record<string, string | undefined>,
): Relogin {
  return async (name) => {
    const sump = resolve(name);
    if (!sump) throw new Error(`no Sump named "${name}"`);
    if (!vault) throw new Error("the key vault is not available");
    if (vault.state === "none" && !vault.needsPassphrase()) vault.create();
    if (vault.state !== "unlocked") throw new Error("the key vault is locked");
    await login(sump, userName(env), ensureIdentity(vault), tokens);
  };
}
