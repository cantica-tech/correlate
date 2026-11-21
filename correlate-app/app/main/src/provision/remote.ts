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
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { userName } from "../identity/identity.js";
import { privateKeyFrom } from "../identity/sshkey.js";
import type { SumpResolver } from "../sump/ipc.js";
import {
  composeFile,
  type ProvisionContext,
  type ProvisionResult,
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
  options: { keyPem?: string } = {},
): Promise<ProvisionResult> {
  const log = ctx.logger ?? console;
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
  const compose = `docker compose -f ${REMOTE_DIR}/docker-compose.yml -p ${REMOTE_PROJECT}`;
  ctx.lifecycle.provision(id, `provisioning on ${details.sshTarget}`);
  let imported = false;
  let started = false;
  let shell: RemoteShell | undefined;
  try {
    const identity = unlockedIdentity(ctx);
    let key = identity.key;
    if (options.keyPem) {
      key = privateKeyFrom(options.keyPem);
      ctx.vault?.put(sshKeyId, options.keyPem);
      imported = true;
    }
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
    await must(shell, "write the compose file", `cat > ${REMOTE_DIR}/docker-compose.yml`, {
      input: composeFile(image, details.sumpPort),
    });
    started = true;
    const up = await shell.exec(`${compose} up -d`, { timeoutMs: 10 * 60_000 });
    if (up.code !== 0) {
      log.warn(
        `the host could not start the Sump (${up.stderr.trim()}); copying the image over SSH`,
      );
      await (ctx.streamImage ?? streamImageOverSsh)(shell, image);
      await must(shell, "start the Sump", `${compose} up -d`, { timeoutMs: 5 * 60_000 });
    }
    const healthy = `${compose} exec -T sump python -c ${shellQuote(
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
      `${compose} exec -T sump python -m correlate_sump.users set-owner --user ${shellQuote(user)}`,
      { input: `${identity.publicKey}\n`, timeoutMs: 30_000 },
    );
    ctx.pending.set(id, { id, details, hostKey: shell.hostKey, sshKeyId });
    log.info(`Sump ${id} provisioned on ${details.sshTarget}; waiting for its first connect`);
    return { ok: true, id, switched: false };
  } catch (error) {
    const step = error instanceof ProvisionError ? error.step : "provision";
    const message =
      error instanceof ProvisionError ? error.reason : String((error as Error).message ?? error);
    log.warn(`remote provisioning of ${details.sshTarget} failed at "${step}": ${message}`);
    if (shell && started) await shell.exec(`${compose} down`, { timeoutMs: 120_000 });
    if (imported) ctx.vault?.remove(sshKeyId);
    ctx.lifecycle.move(id, "retired", `provisioning failed at "${step}"`);
    return { ok: false, step, message };
  } finally {
    shell?.close();
  }
}
