/**
 * Provisioning a Sump on this machine (REQ-000014-sJpO9KMY Requirement 3).
 *
 * The compose file goes to `~/.correlate/sumps/local/`, with the Sump's image
 * (`CORRELATE_SUMP_IMAGE`, else `ghcr.io/oliben67/correlate-sump:<version>`),
 * its ports on 127.0.0.1 only (br-SUMP-000009-sJpO9KMY) and its data volume.
 * Docker starts it; the user becomes its owner with the identity key
 * (br-CONN-000007-sJpO9KMY); the app logs in; only then is the Sump recorded
 * (br-SUMP-000001-sJpO9KMY), made `active` (br-SUMP-000011-sJpO9KMY) and, if
 * asked, made the window's Sump. Any failure stops the containers, retires
 * the Sump from `provisioning` and leaves every window where it was
 * (br-SUMP-000007-sJpO9KMY, cttc BUG-000006-uKKrzikI).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Catalog } from "../catalog/catalog.js";
import { LOCAL_ID } from "../catalog/catalog.js";
import type { Lifecycle } from "../catalog/lifecycle.js";
import type { ActiveSumps } from "../catalog/windows.js";
import { ensureIdentity, identityPublicKey, userName } from "../identity/identity.js";
import { request } from "../sump/client.js";
import type { Sump } from "../sump/errors.js";
import { login } from "../sump/login.js";
import type { SessionTokens } from "../sump/tokens.js";
import { ensurePrivateDir } from "../vault/secure.js";
import type { Vault } from "../vault/vault.js";
import { dockerAvailable } from "./plan.js";
import { mustRun, ProvisionError, type Runner } from "./runner.js";

/** The registry image, tagged with the app's version (FEAT-000015-sJpO9KMY). */
export const IMAGE_REPOSITORY = "ghcr.io/oliben67/correlate-sump";

/** The compose project of the local Sump. */
export const LOCAL_PROJECT = "correlate-sump-local";

/** The Sump image to run: `CORRELATE_SUMP_IMAGE`, else the registry's for this version. */
export function sumpImage(env: Record<string, string | undefined>, appVersion: string): string {
  return env.CORRELATE_SUMP_IMAGE || `${IMAGE_REPOSITORY}:${appVersion}`;
}

/**
 * The compose file of a Sump: every port on 127.0.0.1 only
 * (br-SUMP-000009), Redis not published, users and keys on a volume.
 */
export function composeFile(image: string, sumpPort: number, fluentPort = 5140): string {
  return [
    "# Written by correlate-app (REQ-000014-sJpO9KMY); every port is loopback only.",
    "services:",
    "  sump:",
    `    image: ${JSON.stringify(image)}`,
    "    restart: unless-stopped",
    "    ports:",
    `      - "127.0.0.1:${sumpPort}:8765"`,
    `      - "127.0.0.1:${fluentPort}:5140"`,
    "    environment:",
    "      SUMP_DATA_DIR: /var/lib/correlate-sump",
    "    volumes:",
    "      - sump-data:/var/lib/correlate-sump",
    "volumes:",
    "  sump-data:",
    "",
  ].join("\n");
}

/** Everything local provisioning works with. */
export interface ProvisionContext {
  run: Runner;
  lifecycle: Lifecycle;
  tokens: SessionTokens;
  vault: Vault | undefined;
  env: Record<string, string | undefined>;
  appVersion: string;
  catalog?: Catalog;
  active?: ActiveSumps;
  /** Where the local Sump's compose file goes; `~/.correlate/sumps/local`. */
  localDir?: string;
  /** The compose project of the local Sump; `LOCAL_PROJECT` (tests use their own). */
  localProject?: string;
  /** How long to wait for `/health`; 60 s. */
  healthTimeoutMs?: number;
  logger?: { info(message: string): void; warn(message: string): void };
}

/** What the screens get back: never an exception. */
export type ProvisionResult =
  | { ok: true; id: string; switched: boolean }
  | { ok: false; step: string; message: string };

/** Wait for `/health` to answer with Redis up. */
export async function waitHealthy(sump: Sump, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const health = await request<{ redis?: boolean }>(sump, "GET", "/health", {
        timeoutMs: 2_000,
        logger: { warn: () => {} },
      });
      if (health?.redis) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      throw new ProvisionError("wait for the Sump", `no healthy answer in ${timeoutMs / 1000} s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** The vault, unlocked, with the identity key in it. */
export function unlockedIdentity(ctx: ProvisionContext) {
  const vault = ctx.vault;
  if (!vault) throw new ProvisionError("open the key vault", "the key vault is not available");
  if (vault.state === "none" && !vault.needsPassphrase()) vault.create();
  if (vault.state !== "unlocked") {
    throw new ProvisionError("open the key vault", "the key vault is locked");
  }
  return { key: ensureIdentity(vault), publicKey: identityPublicKey(vault) };
}

/**
 * Provision a Sump on this machine. With `switchTo`, the window `windowId`
 * moves to it once it is connected; without ("Later"), every window stays
 * where it is.
 */
export async function provisionLocal(
  ctx: ProvisionContext,
  options: { sumpPort?: number; windowId?: number; switchTo?: boolean } = {},
): Promise<ProvisionResult> {
  const log = ctx.logger ?? console;
  const sumpPort = options.sumpPort ?? 8765;
  const known = ctx.lifecycle.get(LOCAL_ID);
  if (known && !(known.state === "retired" && !ctx.catalog?.get(LOCAL_ID))) {
    return {
      ok: false,
      step: "check",
      message:
        known.state === "retired"
          ? "this machine's Sump was uninstalled; adding it again comes with Item 16"
          : "this machine already has a Sump",
    };
  }
  if (!(await dockerAvailable(ctx.run))) {
    return { ok: false, step: "check Docker", message: "Docker is not available on this machine" };
  }
  const dir = ctx.localDir ?? path.join(homedir(), ".correlate", "sumps", "local");
  const file = path.join(dir, "docker-compose.yml");
  const compose = ["compose", "-f", file, "-p", ctx.localProject ?? LOCAL_PROJECT];
  const sump: Sump = { name: LOCAL_ID, baseUrl: `http://127.0.0.1:${sumpPort}` };
  ctx.lifecycle.provision(LOCAL_ID, "provisioning on this machine");
  let started = false;
  try {
    const { key, publicKey } = unlockedIdentity(ctx);
    const user = userName(ctx.env);
    ensurePrivateDir(path.dirname(dir));
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, composeFile(sumpImage(ctx.env, ctx.appVersion), sumpPort));
    log.info(`provisioning the local Sump with ${sumpImage(ctx.env, ctx.appVersion)}`);
    started = true;
    await mustRun(ctx.run, "start the Sump", "docker", [...compose, "up", "-d"], {
      timeoutMs: 10 * 60_000,
    });
    await waitHealthy(sump, ctx.healthTimeoutMs ?? 60_000);
    await mustRun(
      ctx.run,
      "make you its owner",
      "docker",
      [...compose, "exec", "-T", "sump"].concat([
        "python",
        "-m",
        "correlate_sump.users",
        "set-owner",
        "--user",
        user,
      ]),
      { input: `${publicKey}\n`, timeoutMs: 30_000 },
    );
    try {
      await login(sump, user, key, ctx.tokens);
    } catch (error) {
      throw new ProvisionError("log in", (error as Error).message);
    }
    ctx.catalog?.recordConnect({ kind: "local", sumpPort, user });
    ctx.lifecycle.move(LOCAL_ID, "active", `provisioned and logged in as ${user}`);
    let switched = false;
    if (options.switchTo && options.windowId !== undefined && ctx.active) {
      ctx.active.set(options.windowId, LOCAL_ID);
      switched = true;
    }
    return { ok: true, id: LOCAL_ID, switched };
  } catch (error) {
    const step = error instanceof ProvisionError ? error.step : "provision";
    const message = error instanceof ProvisionError ? error.reason : String(error);
    log.warn(`local provisioning failed: ${message}`);
    if (started) {
      // Stop what was started; the data volume stays, in case it holds an owner's data.
      await ctx.run("docker", [...compose, "down"], { timeoutMs: 120_000 });
    }
    ctx.tokens.forget(LOCAL_ID);
    ctx.lifecycle.move(LOCAL_ID, "retired", `provisioning failed at "${step}"`);
    return { ok: false, step, message };
  }
}
