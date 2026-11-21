/**
 * Edit, Switch and Uninstall (REQ-000015-sJpO9KMY).
 *
 * Every path keeps what works until the new state is proven: a new SSH key
 * replaces the old one only once it logs in (br-VAULT-000007-sJpO9KMY), a
 * window moves only to a Sump that answers (br-SUMP-000003-sJpO9KMY), and
 * uninstall retires a Sump only once its containers, image and data are gone
 * (br-SUMP-000004-sJpO9KMY). Every path that switches a window asks first
 * while a recording is live (`SwitchGuard`, cttc BUG-000029-uKKrzikI).
 */
import { homedir, userInfo } from "node:os";
import path from "node:path";
import type { SumpEntry } from "../catalog/catalog.js";
import { privateKeyFrom } from "../identity/sshkey.js";
import { request } from "../sump/client.js";
import { SumpHttpError } from "../sump/errors.js";
import { confirmNeeded, LOCAL_PROJECT } from "./local.js";
import { REMOTE_DIR, REMOTE_PROJECT, type RemoteContext, sshKeyIdFor } from "./remote.js";
import { connectSsh, type SshTarget } from "./ssh.js";

/** What every management call answers; never an exception. */
export type ManageResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; step: string; message: string; [key: string]: unknown };

/** Where a remote Sump's SSH goes, as whom, with which key, checked against its pinned host key. */
export function sshTargetOf(
  ctx: Pick<RemoteContext, "vault">,
  entry: Pick<SumpEntry, "sshTarget" | "sshPort" | "sshKeyId" | "hostKey">,
  keyPem?: string,
): SshTarget {
  const target = entry.sshTarget ?? "";
  const at = target.lastIndexOf("@");
  const keyId = entry.sshKeyId ?? "identity";
  const pem = keyPem ?? ctx.vault?.get(keyId);
  if (!pem) throw new Error(`no SSH key ${keyId} in the vault`);
  return {
    host: (at === -1 ? target : target.slice(at + 1)).replace(/^\[|\]$/g, ""),
    port: entry.sshPort ?? 22,
    username: at === -1 ? userInfo().username : target.slice(0, at),
    key: privateKeyFrom(pem),
    knownHostKey: entry.hostKey,
  };
}

/** Rename a live Sump. */
export function renameSump(ctx: RemoteContext, id: string, name: unknown): ManageResult {
  if (typeof name !== "string" || !name.trim() || name.length > 100) {
    return { ok: false, step: "check", message: "a name is 1 to 100 characters" };
  }
  try {
    const entry = ctx.catalog?.amend(id, { name });
    if (!entry) return { ok: false, step: "check", message: "there is no catalog" };
    return { ok: true, name: entry.name };
  } catch (error) {
    return { ok: false, step: "check", message: (error as Error).message };
  }
}

/**
 * Give a remote Sump a new SSH key: it must log in to the Sump's host, whose
 * key must still be the one pinned, before it is stored under `ssh:<id>` and
 * the Sump pointed at it. A failed login changes nothing.
 */
export async function replaceSshKey(
  ctx: RemoteContext,
  id: string,
  keyPem: string,
): Promise<ManageResult> {
  const entry = ctx.catalog?.get(id);
  if (!entry || entry.retiredAt !== undefined || entry.kind !== "remote") {
    return { ok: false, step: "check", message: `no live remote Sump ${id}` };
  }
  const vault = ctx.vault;
  if (vault?.state !== "unlocked") {
    return { ok: false, step: "open the key vault", message: "the key vault is not unlocked" };
  }
  const keyId = sshKeyIdFor(id);
  const connect = ctx.connect ?? connectSsh;
  try {
    await vault.replace(keyId, keyPem, async (pem) => {
      const shell = await connect(sshTargetOf(ctx, entry, pem));
      shell.close();
    });
  } catch (error) {
    return { ok: false, step: "log in with the new key", message: (error as Error).message };
  }
  ctx.catalog?.amend(id, { sshKeyId: keyId });
  (ctx.logger ?? console).info(`Sump ${id}: SSH key replaced`);
  return { ok: true, sshKeyId: keyId };
}

/**
 * Move window `windowId` to Sump `id`, once that Sump answers `/health`
 * (5 s). A Sump that is retired, unknown, not reachable yet or silent is
 * refused, and the window keeps its Sump and its token
 * (br-SUMP-000003-sJpO9KMY). Asks first while a recording is live.
 */
export async function switchSump(
  ctx: RemoteContext,
  windowId: number,
  id: string,
  options: { confirmed?: boolean } = {},
): Promise<ManageResult> {
  const ask = confirmNeeded(ctx.guard, options.confirmed);
  if (ask) return ask;
  const state = ctx.lifecycle.get(id)?.state;
  if (state === "retired" || state === "provisioning") {
    return { ok: false, step: "check", message: `Sump ${id} is ${state}` };
  }
  const sump = ctx.resolve?.(id);
  if (!sump) {
    return { ok: false, step: "reach the Sump", message: `Sump ${id} cannot be reached yet` };
  }
  try {
    await request(sump, "GET", "/health", { timeoutMs: 5_000, logger: { warn: () => {} } });
  } catch (error) {
    if (!(error instanceof SumpHttpError)) {
      ctx.lifecycle.unreachable(id, `switch refused: ${(error as Error).message}`);
      return { ok: false, step: "reach the Sump", message: (error as Error).message };
    }
  }
  ctx.lifecycle.reachable(id, "answered before a switch");
  try {
    ctx.active?.set(windowId, id);
  } catch (error) {
    return { ok: false, step: "check", message: (error as Error).message };
  }
  return { ok: true, id };
}

/** What uninstalling a Sump removes, for the confirmation the screens show. */
export const UNINSTALL_REMOVES = [
  "the Sump's containers",
  "its image",
  "its data: users, keys and stored records",
];

/**
 * Uninstall Sump `id`, once confirmed: `docker compose down -v --rmi all`
 * here or on its host (whose install folder is then deleted), then the Sump
 * retired, its own SSH key and its token forgotten, and every window on it
 * moved to the most recently connected active Sump, or to none
 * (br-SUMP-000004-sJpO9KMY). A failure retires nothing and says whether the
 * container is still there.
 */
export async function uninstallSump(
  ctx: RemoteContext,
  id: string,
  options: { confirmed?: boolean } = {},
): Promise<ManageResult> {
  const entry = ctx.catalog?.get(id);
  if (!entry || entry.retiredAt !== undefined) {
    return { ok: false, step: "check", message: `no live Sump ${id}` };
  }
  const windows = ctx.active?.windowsOn(id) ?? [];
  const recording = windows.length > 0 ? ctx.guard?.liveRecording() : undefined;
  if (!options.confirmed) {
    const warning = recording ? ` Recording "${recording}" is live and will be abandoned.` : "";
    return {
      ok: false,
      step: "confirm",
      message: `Uninstalling "${entry.name}" removes ${UNINSTALL_REMOVES.join(", ")}.${warning} Confirm to go on.`,
      removes: UNINSTALL_REMOVES,
    };
  }
  const log = ctx.logger ?? console;
  try {
    if (entry.kind === "local") {
      const dir = ctx.localDir ?? path.join(homedir(), ".correlate", "sumps", "local");
      const compose = [
        "compose",
        "-f",
        path.join(dir, "docker-compose.yml"),
        "-p",
        ctx.localProject ?? LOCAL_PROJECT,
      ];
      const down = await ctx.run("docker", [...compose, "down", "-v", "--rmi", "all"], {
        timeoutMs: 5 * 60_000,
      });
      if (down.code !== 0) {
        const ps = await ctx.run("docker", [...compose, "ps", "-q"], { timeoutMs: 30_000 });
        return {
          ok: false,
          step: "remove the Sump",
          message: (down.stderr || down.stdout).trim() || `exit ${down.code}`,
          containerRemains: ps.code !== 0 || ps.stdout.trim() !== "",
        };
      }
    } else {
      const compose = `docker compose -f ${REMOTE_DIR}/docker-compose.yml -p ${REMOTE_PROJECT}`;
      let shell: Awaited<ReturnType<NonNullable<RemoteContext["connect"]>>> | undefined;
      try {
        shell = await (ctx.connect ?? connectSsh)(sshTargetOf(ctx, entry));
      } catch (error) {
        return {
          ok: false,
          step: "connect over SSH",
          message: (error as Error).message,
          containerRemains: true,
        };
      }
      try {
        const down = await shell.exec(`${compose} down -v --rmi all && rm -rf ${REMOTE_DIR}`, {
          timeoutMs: 5 * 60_000,
        });
        if (down.code !== 0) {
          const ps = await shell.exec(`${compose} ps -q`, { timeoutMs: 30_000 });
          return {
            ok: false,
            step: "remove the Sump",
            message: (down.stderr || down.stdout).trim() || `exit ${down.code}`,
            containerRemains: ps.code !== 0 || ps.stdout.trim() !== "",
          };
        }
      } finally {
        shell.close();
      }
    }
  } catch (error) {
    return {
      ok: false,
      step: "remove the Sump",
      message: (error as Error).message,
      containerRemains: true,
    };
  }
  ctx.forwards?.stop(id);
  if (ctx.lifecycle.get(id)) ctx.lifecycle.move(id, "retired", "uninstalled");
  else ctx.catalog?.retire(id);
  if (entry.sshKeyId?.startsWith("ssh:")) ctx.vault?.remove(entry.sshKeyId);
  ctx.tokens.forget(id);
  ctx.pending.delete(id);
  const fallback = (ctx.catalog?.list() ?? [])
    .filter((e) => e.id !== id && ctx.lifecycle.get(e.id)?.state === "active")
    .sort((a, b) => b.lastConnectedAt.localeCompare(a.lastConnectedAt))[0];
  for (const window of windows) {
    if (fallback) ctx.active?.set(window, fallback.id);
    else ctx.active?.clear(window);
  }
  log.info(
    `Sump ${id} uninstalled; ${windows.length} window(s) moved to ${fallback?.id ?? "none"}`,
  );
  return { ok: true, id, movedTo: fallback?.id ?? null };
}
