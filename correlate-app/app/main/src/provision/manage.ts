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
import { userInfo } from "node:os";
import type { SumpEntry } from "../catalog/catalog.js";
import { privateKeyFrom } from "../identity/sshkey.js";
import type { RemoteContext } from "./remote.js";
import { sshKeyIdFor } from "./remote.js";
import { connectSsh, type SshTarget } from "./ssh.js";

/** What every management call answers; never an exception. */
export type ManageResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; step: string; message: string; [key: string]: unknown };

/** Where a remote Sump's SSH goes, as whom, with which key, checked against its pinned host key. */
export function sshTargetOf(ctx: RemoteContext, entry: SumpEntry, keyPem?: string): SshTarget {
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
