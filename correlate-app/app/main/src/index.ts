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
import { Catalog, defaultCatalogPath, LOCAL_ID } from "./catalog/catalog.js";
import { Lifecycle } from "./catalog/lifecycle.js";
import { HealthProbe } from "./catalog/probe.js";
import { ActiveSumps } from "./catalog/windows.js";
import { ensureIdentity, userName } from "./identity/identity.js";
import { sshTargetOf } from "./provision/manage.js";
import type { Sump } from "./sump/errors.js";
import { Forwards } from "./sump/forward.js";
import type { Relogin, SumpResolver } from "./sump/ipc.js";
import { login } from "./sump/login.js";
import { SessionTokens } from "./sump/tokens.js";
import type { SafeStorageLike } from "./vault/cipher.js";
import { Vault, type VaultLogger } from "./vault/vault.js";

export { Auditor } from "./catalog/audit.js";
export { identityPublicKey, importIdentity, userName } from "./identity/identity.js";
export { fieldMenuTemplate, nativeMenuTemplate, registerMenuIpc } from "./menu.js";
export { Notifications, notifyLifecycle, registerStatusIpc } from "./notify.js";
export { registerPickerIpc } from "./picker.js";
export { registerProvisionIpc } from "./provision/ipc.js";
export { runCommand } from "./provision/runner.js";
export { connectSsh } from "./provision/ssh.js";
export {
  registerSidebarIpc,
  SIDEBAR_LAYOUT_EVENT,
  SIDEBAR_RUN_EVENT,
  SidebarHost,
} from "./sidebar.js";
export { ActiveStreams, registerStreamIpc } from "./streams.js";
export { logout } from "./sump/client.js";
export { registerSumpIpc, SUMP_STATE_EVENT } from "./sump/ipc.js";
export { login } from "./sump/login.js";
export { defaultSettingsPath, registerThemeIpc, Settings } from "./theme.js";
export { ActiveSumps, Forwards, HealthProbe, Lifecycle, SessionTokens };

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
  catalog?: Catalog,
  forwards?: Forwards,
): SumpResolver {
  const fallback = env.CORRELATE_SUMP_URL || DEFAULT_SUMP_URL;
  new URL(fallback); // An invalid URL stops the app at startup, not at the first call.
  if (env.CORRELATE_SUMP_TOKEN) tokens.set(LOCAL_ID, env.CORRELATE_SUMP_TOKEN);
  return (id) => {
    let sump: Sump | undefined;
    const entry = catalog?.get(id);
    if (entry?.retiredAt !== undefined) return undefined;
    if (entry?.kind === "local") {
      sump = { name: id, baseUrl: env.CORRELATE_SUMP_URL || `http://127.0.0.1:${entry.sumpPort}` };
    } else if (entry === undefined && id === LOCAL_ID) {
      sump = { name: LOCAL_ID, baseUrl: fallback };
    }
    if (entry?.kind === "remote") {
      // Only through its SSH forward, once up (br-SUMP-000009-sJpO9KMY).
      const url = forwards?.urlOf(id);
      if (url) sump = { name: id, baseUrl: url };
    }
    if (!sump) return undefined;
    const token = tokens.get(id);
    return token ? { ...sump, token } : sump;
  };
}

/**
 * Open the catalog at `~/.correlate/catalog.db` (or `CORRELATE_CATALOG`). A
 * corrupt catalog is reported and left untouched; the app then runs without
 * one (br-SUMP-000001-sJpO9KMY).
 */
export function openCatalog(
  env: Record<string, string | undefined>,
  logger: VaultLogger = console,
): Catalog | undefined {
  try {
    return Catalog.open(env.CORRELATE_CATALOG || defaultCatalogPath());
  } catch (error) {
    logger.warn(`catalog not opened: ${(error as Error).message}`);
    return undefined;
  }
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
  catalog?: Catalog,
  lifecycle?: Lifecycle,
  afterConnect?: () => void,
): Relogin {
  return async (name) => {
    const sump = resolve(name);
    if (!sump) throw new Error(`no Sump named "${name}"`);
    if (!vault) throw new Error("the key vault is not available");
    if (vault.state === "none" && !vault.needsPassphrase()) vault.create();
    if (vault.state !== "unlocked") throw new Error("the key vault is locked");
    const result = await login(sump, userName(env), ensureIdentity(vault), tokens);
    // A Sump is recorded only after a successful connect (br-SUMP-000001).
    const entry = catalog?.get(name);
    if (catalog && (entry || name === LOCAL_ID)) {
      const port = Number(new URL(sump.baseUrl).port) || 8765;
      catalog.recordConnect(
        entry
          ? { ...entry, id: entry.id, user: result.user }
          : { kind: "local", sumpPort: port, user: result.user },
      );
    }
    lifecycle?.reachable(name, `logged in as ${result.user}`);
    afterConnect?.();
  };
}

/**
 * Start the SSH forward of every live remote Sump (br-SUMP-000010-sJpO9KMY:
 * kept connected in the background). A Sump whose key cannot be read now (a
 * locked vault) is skipped and logged; it starts once the vault opens.
 */
export function startForwards(
  forwards: Forwards,
  catalog: Catalog | undefined,
  vault: Vault | undefined,
  logger: { warn(message: string): void } = console,
): string[] {
  const started: string[] = [];
  for (const entry of catalog?.list() ?? []) {
    if (entry.kind !== "remote") continue;
    try {
      forwards.ensure({
        id: entry.id,
        sumpPort: entry.sumpPort,
        ssh: sshTargetOf({ vault }, entry),
      });
      started.push(entry.id);
    } catch (error) {
      logger.warn(`Sump ${entry.id}: SSH forward not started (${(error as Error).message})`);
    }
  }
  return started;
}
