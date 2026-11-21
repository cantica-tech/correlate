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

/** The Docker socket, mounted into the Sump so it watches its own host (REQ-000024-sJpO9KMY). */
export const DOCKER_SOCKET = "/var/run/docker.sock";

/**
 * `docker` arguments that print the Docker socket's group ID as the Sump's
 * container sees it, with the Sump image itself: the Sump runs as a user who
 * may use the socket only through that group, and the ID differs between
 * hosts (0 under Docker Desktop, the `docker` group's on Linux).
 */
export function socketGroupArgs(image: string): string[] {
  return [
    "run",
    "--rm",
    "--entrypoint",
    "stat",
    "-v",
    `${DOCKER_SOCKET}:${DOCKER_SOCKET}`,
    image,
    "-c",
    "%g",
    DOCKER_SOCKET,
  ];
}

/** The group ID `socketGroupArgs` printed; a `ProvisionError` if it is not one. */
export function parseSocketGroup(stdout: string): number {
  const text = stdout.trim();
  if (!/^\d{1,10}$/.test(text)) {
    throw new ProvisionError(
      "find the Docker socket's group",
      `expected a group ID, got ${JSON.stringify(text.slice(0, 80))}`,
    );
  }
  return Number(text);
}

/**
 * The compose file of a Sump: every port on 127.0.0.1 only
 * (br-SUMP-000009), Redis not published, users and keys on a volume; and
 * the host's Docker socket mounted, with its group, so the Sump can watch
 * its own host (decided in FEAT-000025-sJpO9KMY): this lets the Sump run any
 * Docker command on its host, which the provisioning plan says.
 */
export function composeFile(
  image: string,
  sumpPort: number,
  socketGroup: number,
  fluentPort = 5140,
): string {
  if (!Number.isInteger(socketGroup) || socketGroup < 0) {
    throw new Error(`the Docker socket's group is a whole number, not ${socketGroup}`);
  }
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
    "    # The host's Docker, for the Sump to watch its own host (REQ-000024-sJpO9KMY).",
    "    group_add:",
    `      - "${socketGroup}"`,
    "    volumes:",
    "      - sump-data:/var/lib/correlate-sump",
    `      - ${DOCKER_SOCKET}:${DOCKER_SOCKET}`,
    "volumes:",
    "  sump-data:",
    "",
  ].join("\n");
}

/** A compose file that would publish a port beyond loopback, or use host networking. */
export class ComposeLoopbackError extends Error {
  override readonly name = "ComposeLoopbackError";
}

/**
 * Refuse a compose file that publishes a port on anything but 127.0.0.1, or
 * uses host networking, before it is written anywhere
 * (br-SUMP-000009-sJpO9KMY).
 */
export function checkComposeLoopback(text: string): void {
  if (/^\s*network_mode:\s*["']?host/m.test(text)) {
    throw new ProvisionError("check the compose file", "it uses host networking");
  }
  for (const line of text.split("\n")) {
    const port = /^\s*-\s*["']?([^"'\s]+)["']?\s*$/.exec(line)?.[1];
    if (!port || !/^[\d.:[\]a-fA-F]+:\d+(?:\/\w+)?$/.test(port)) continue;
    if (!/^127\.0\.0\.1:\d+:\d+(?:\/\w+)?$/.test(port)) {
      throw new ProvisionError(
        "check the compose file",
        `port ${port} is not bound to 127.0.0.1 only`,
      );
    }
  }
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
  /** Says whether a recording is live, so switching asks first (cttc BUG-000029). */
  guard?: SwitchGuard;
  /** How long to wait for `/health`; 60 s. */
  healthTimeoutMs?: number;
  logger?: { info(message: string): void; warn(message: string): void };
}

/**
 * Whether a recording is live: every path that switches a window asks for
 * confirmation first while one is (br-REC-000001-sJpO9KMY, cttc
 * BUG-000029-uKKrzikI). Phase 8 plugs the recordings in; until then none is.
 */
export interface SwitchGuard {
  /** The live recording's name, if one is live. */
  liveRecording(): string | undefined;
}

/** The answer while a recording is live and the call was not confirmed. */
export function confirmNeeded(guard: SwitchGuard | undefined, confirmed: boolean | undefined) {
  const recording = guard?.liveRecording();
  if (!recording || confirmed) return undefined;
  return {
    ok: false as const,
    step: "confirm",
    message: `recording "${recording}" is live; switching Sumps abandons it. Confirm to go on.`,
  };
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
  options: { sumpPort?: number; windowId?: number; switchTo?: boolean; confirmed?: boolean } = {},
): Promise<ProvisionResult> {
  const log = ctx.logger ?? console;
  if (options.switchTo) {
    const ask = confirmNeeded(ctx.guard, options.confirmed);
    if (ask) return ask;
  }
  const sumpPort = options.sumpPort ?? 8765;
  const known = ctx.lifecycle.get(LOCAL_ID);
  if (known && known.state !== "retired") {
    return { ok: false, step: "check", message: "this machine already has a Sump; use Edit" };
  }
  if (known && ctx.catalog?.get(LOCAL_ID)) {
    // An uninstalled local Sump stays as history; the new one starts afresh
    // (br-SUMP-000002-sJpO9KMY).
    const archive = ctx.catalog.archiveRetiredLocal();
    if (archive) ctx.lifecycle.renameRetired(LOCAL_ID, archive);
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
    const image = sumpImage(ctx.env, ctx.appVersion);
    // Pulls the image if it is not here yet, as `up` would.
    const group = await mustRun(
      ctx.run,
      "find the Docker socket's group",
      "docker",
      socketGroupArgs(image),
      { timeoutMs: 10 * 60_000 },
    );
    const composeText = composeFile(image, sumpPort, parseSocketGroup(group.stdout));
    checkComposeLoopback(composeText);
    writeFileSync(file, composeText);
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
