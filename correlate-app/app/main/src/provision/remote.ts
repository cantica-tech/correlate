/**
 * Provisioning a Sump on a remote host over SSH (REQ-000014-sJpO9KMY
 * Requirements 4 and 5).
 *
 * The SSH key is chosen per Sump (FEAT-000015-sJpO9KMY): the identity key, or
 * a key imported for this Sump under `ssh:<id>`. The host key is accepted on
 * first use and kept with the pending Sump. On the host: Docker is checked,
 * the compose file goes to `~/.correlate-sump/`, the Sump starts with its
 * ports on the host's loopback only (br-SUMP-000009-sJpO9KMY); if the host
 * cannot pull the image, it is streamed over SSH (`docker save` here, `docker
 * load` there). The owner is set with the identity key. The Sump then stays
 * `provisioning` until its first connect, which needs the SSH forward of
 * Item 17.
 *
 * Any failure stops what was started, deletes a key imported for this Sump
 * (br-SUMP-000007-sJpO9KMY), retires the Sump from `provisioning`, and moves
 * no window (cttc BUG-000006-uKKrzikI). Remote commands are built from
 * constants and checked values only, each quoted (br-SUMP-000006-sJpO9KMY).
 */

import { spawn } from "node:child_process";
import { type KeyObject, randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { userName } from "../identity/identity.js";
import { privateKeyFrom } from "../identity/sshkey.js";
import type { Forwards } from "../sump/forward.js";
import type { SumpResolver } from "../sump/ipc.js";
import { login } from "../sump/login.js";
import {
  abandonIfLive,
  checkComposeLoopback,
  composeFile,
  confirmNeeded,
  type ProvisionContext,
  type ProvisionResult,
  parseSocketGroup,
  socketGroupArgs,
  sumpImage,
  unlockedIdentity,
} from "./local.js";
import type { RemoteDetails } from "./plan.js";
import { ProvisionError } from "./runner.js";
import { connectSsh, type RemoteShell, type SshConnect, shellQuote } from "./ssh.js";

/** Where the compose file goes on the host, and the compose project. */
export const REMOTE_DIR = "~/.correlate-sump";
export const REMOTE_PROJECT = "correlate-sump";

/** A Sump provisioned on a host, waiting for its first connect (Item 17). */
export interface PendingSump {
  id: string;
  details: RemoteDetails;
  /** The host key accepted on first use. */
  hostKey: string;
  /** The vault id of the SSH key: `identity`, or `ssh:<id>` when imported. */
  sshKeyId: string;
}

/** What remote provisioning needs beyond local provisioning's context. */
export interface RemoteContext extends ProvisionContext {
  connect?: SshConnect;
  /** Finds a Sump to call (the catalog's resolver); Switch checks the target with it. */
  resolve?: SumpResolver;
  /** Every remote Sump's SSH forward (Item 17); a new Sump's first connect opens its own. */
  forwards?: Forwards;
  /** How long a first connect waits for the forward; 30 s. */
  firstConnectTimeoutMs?: number;
  /** Runs after each new Sump's first successful connect (the audit). */
  afterConnect?: () => void;
  /** Runs the audit on demand. */
  audit?: () => Promise<unknown>;
  /** Pending Sumps, until Item 17 connects them. */
  pending: Map<string, PendingSump>;
  /** Streams the image to the host when it cannot pull it. */
  streamImage?: (shell: RemoteShell, image: string) => Promise<void>;
  /** Pause between health checks on the host; 2 s. */
  pollMs?: number;
}

/** A host, without its user, lowered: what "the same host" means for New. */
function hostOf(target: string): string {
  const at = target.lastIndexOf("@");
  return (at === -1 ? target : target.slice(at + 1)).toLowerCase();
}

/**
 * The name of a live Sump (in the catalog, or being provisioned) on the same
 * host and Sump port; a retired one does not count, so an uninstalled host
 * can be added again (br-SUMP-000002-sJpO9KMY, cttc BUG-000004-uKKrzikI).
 */
export function hostWithLiveSump(ctx: RemoteContext, details: RemoteDetails): string | undefined {
  const host = hostOf(details.sshTarget);
  const live = (ctx.catalog?.list() ?? []).find(
    (e) =>
      e.kind === "remote" && hostOf(e.sshTarget ?? "") === host && e.sumpPort === details.sumpPort,
  );
  if (live) return live.name;
  const pending = [...ctx.pending.values()].find(
    (p) =>
      hostOf(p.details.sshTarget) === host &&
      p.details.sumpPort === details.sumpPort &&
      ctx.lifecycle.get(p.id)?.state === "provisioning",
  );
  return pending ? (pending.details.name ?? pending.details.sshTarget) : undefined;
}

/** The vault id of a key imported for one Sump. */
export function sshKeyIdFor(sumpId: string): string {
  return `ssh:${sumpId}`;
}

/** Stream `docker save <image>` from here into `docker load` on the host. */
export async function streamImageOverSsh(shell: RemoteShell, image: string): Promise<void> {
  const save = spawn("docker", ["save", image], { shell: false, windowsHide: true });
  const loaded = await shell.exec("docker load", { input: save.stdout, timeoutMs: 30 * 60_000 });
  if (loaded.code !== 0) {
    throw new ProvisionError(
      "copy the image to the host",
      loaded.stderr.trim() || "docker load failed",
    );
  }
}

async function must(shell: RemoteShell, step: string, command: string, options = {}) {
  const result = await shell.exec(command, options);
  if (result.code !== 0) {
    const why = result.timedOut
      ? "timed out"
      : (result.stderr || result.stdout).trim() || `exit ${result.code}`;
    throw new ProvisionError(step, why);
  }
  return result;
}

/**
 * Provision a Sump on `details.sshTarget`. `keyPem`, when given, is the key
 * that opens the host, imported for this Sump; otherwise the identity key.
 */
export async function provisionRemote(
  ctx: RemoteContext,
  details: RemoteDetails,
  options: { keyPem?: string; windowId?: number; switchTo?: boolean; confirmed?: boolean } = {},
): Promise<ProvisionResult> {
  const log = ctx.logger ?? console;
  if (options.switchTo) {
    const ask = confirmNeeded(ctx.guard, options.confirmed);
    if (ask) return ask;
    await abandonIfLive(ctx.guard);
  }
  const taken = hostWithLiveSump(ctx, details);
  if (taken) {
    return {
      ok: false,
      step: "check",
      message: `${details.sshTarget} already has a Sump ("${taken}"); use Edit`,
    };
  }
  const id = randomUUID();
  const sshKeyId = options.keyPem ? sshKeyIdFor(id) : "identity";
  const at = details.sshTarget.lastIndexOf("@");
  const host = (at === -1 ? details.sshTarget : details.sshTarget.slice(at + 1)).replace(
    /^\[|\]$/g,
    "",
  );
  const username = at === -1 ? userInfo().username : details.sshTarget.slice(0, at);
  const image = sumpImage(ctx.env, ctx.appVersion);
  const composeCommand = `docker compose -f ${REMOTE_DIR}/docker-compose.yml -p ${REMOTE_PROJECT}`;
  ctx.lifecycle.provision(id, `provisioning on ${details.sshTarget}`);
  let imported = false;
  let started = false;
  let shell: RemoteShell | undefined;
  let sshKey: KeyObject | undefined;
  try {
    const identity = unlockedIdentity(ctx);
    let key = identity.key;
    if (options.keyPem) {
      key = privateKeyFrom(options.keyPem);
      ctx.vault?.put(sshKeyId, options.keyPem);
      imported = true;
    }
    sshKey = key;
    try {
      shell = await (ctx.connect ?? connectSsh)({ host, port: details.sshPort, username, key });
    } catch (error) {
      throw new ProvisionError("connect over SSH", (error as Error).message);
    }
    log.info(`provisioning ${details.sshTarget} (host key ${shell.hostKey}) with ${image}`);
    await must(shell, "check Docker on the host", "docker version --format '{{.Server.Version}}'", {
      timeoutMs: 20_000,
    });
    await must(shell, "prepare the host", `mkdir -p ${REMOTE_DIR} && chmod 700 ${REMOTE_DIR}`);
    // The image first: the socket's group is read with it (REQ-000024-sJpO9KMY).
    const quoted = shellQuote(image);
    const have = await shell.exec(
      `docker image inspect ${quoted} >/dev/null 2>&1 || docker pull ${quoted}`,
      {
        timeoutMs: 10 * 60_000,
      },
    );
    if (have.code !== 0) {
      log.warn(`the host could not pull the image (${have.stderr.trim()}); copying it over SSH`);
      await (ctx.streamImage ?? streamImageOverSsh)(shell, image);
    }
    const group = await must(
      shell,
      "find the Docker socket's group",
      `docker ${socketGroupArgs(image).map(shellQuote).join(" ")}`,
      { timeoutMs: 60_000 },
    );
    const compose = composeFile(image, details.sumpPort, parseSocketGroup(group.stdout));
    checkComposeLoopback(compose);
    await must(shell, "write the compose file", `cat > ${REMOTE_DIR}/docker-compose.yml`, {
      input: compose,
    });
    started = true;
    await must(shell, "start the Sump", `${composeCommand} up -d`, { timeoutMs: 5 * 60_000 });
    const healthy = `${composeCommand} exec -T sump python -c ${shellQuote(
      "import json,urllib.request;print(json.load(urllib.request.urlopen('http://127.0.0.1:8765/health'))['redis'])",
    )}`;
    const deadline = Date.now() + (ctx.healthTimeoutMs ?? 60_000);
    for (;;) {
      const result = await shell.exec(healthy, { timeoutMs: 10_000 });
      if (result.code === 0 && result.stdout.trim() === "True") break;
      if (Date.now() > deadline)
        throw new ProvisionError("wait for the Sump", "no healthy answer on the host");
      await sleep(ctx.pollMs ?? 2_000);
    }
    const user = userName(ctx.env);
    await must(
      shell,
      "make you its owner",
      `${composeCommand} exec -T sump python -m correlate_sump.users set-owner --user ${shellQuote(user)}`,
      { input: `${identity.publicKey}\n`, timeoutMs: 30_000 },
    );
    const pending: PendingSump = { id, details, hostKey: shell.hostKey, sshKeyId };
    ctx.pending.set(id, pending);
    log.info(`Sump ${id} provisioned on ${details.sshTarget}`);
    shell.close();
    shell = undefined;
    if (!ctx.forwards) return { ok: true, id, switched: false };
    // The first connect: through its own SSH forward, then the login
    // (br-SUMP-000007-sJpO9KMY, br-SUMP-000008-sJpO9KMY).
    const forward = ctx.forwards.ensure({
      id,
      sumpPort: details.sumpPort,
      ssh: { host, port: details.sshPort, username, key, knownHostKey: pending.hostKey },
    });
    if (!(await forward.waitUp(ctx.firstConnectTimeoutMs ?? 30_000))) {
      throw new ProvisionError(
        "connect for the first time",
        forward.lastError ?? "the SSH forward did not come up",
      );
    }
    try {
      await login({ name: id, baseUrl: forward.url as string }, user, identity.key, ctx.tokens);
    } catch (error) {
      throw new ProvisionError("log in", (error as Error).message);
    }
    ctx.catalog?.recordConnect({
      id,
      kind: "remote",
      name: details.name ?? details.sshTarget,
      sshTarget: details.sshTarget,
      sshPort: details.sshPort,
      sumpPort: details.sumpPort,
      user,
      hostKey: pending.hostKey,
      sshKeyId,
    });
    ctx.lifecycle.move(id, "active", `connected through SSH and logged in as ${user}`);
    ctx.pending.delete(id);
    let switched = false;
    if (options.switchTo && options.windowId !== undefined && ctx.active) {
      ctx.active.set(options.windowId, id);
      switched = true;
    }
    return { ok: true, id, switched };
  } catch (error) {
    const step = error instanceof ProvisionError ? error.step : "provision";
    const message =
      error instanceof ProvisionError ? error.reason : String((error as Error).message ?? error);
    log.warn(`remote provisioning of ${details.sshTarget} failed at "${step}": ${message}`);
    ctx.forwards?.stop(id);
    ctx.pending.delete(id);
    ctx.tokens.forget(id);
    if (started) {
      const cleanup =
        shell ??
        (sshKey
          ? await (ctx.connect ?? connectSsh)({
              host,
              port: details.sshPort,
              username,
              key: sshKey,
            }).catch(() => undefined)
          : undefined);
      await cleanup?.exec(`${composeCommand} down`, { timeoutMs: 120_000 });
      if (cleanup !== shell) cleanup?.close();
    }
    if (imported) ctx.vault?.remove(sshKeyId);
    ctx.lifecycle.move(id, "retired", `provisioning failed at "${step}"`);
    return { ok: false, step, message };
  } finally {
    shell?.close();
  }
}
