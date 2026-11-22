/**
 * Promote… (br-FED-000001 and br-FED-000004-sJpO9KMY, REQ-000052-sJpO9KMY
 * step 4): the window's Sump promotes one of its SSH data streams to a
 * secondary Sump on that host, owned by this app's user (its public key is
 * sent), and the secondary joins the catalog as any remote Sump.
 *
 * Joining the catalog is a connect like any other (br-SUMP-000001: recorded
 * only after a successful one): this app reaches the host over SSH with its
 * own key, pins the host key, opens the secondary's own forward and logs in.
 * The promotion stands even when that fails (the app's key not on the host,
 * say): the parent collects through the secondary all the same, and the
 * reason is said.
 */
import { randomUUID } from "node:crypto";
import { userName } from "../identity/identity.js";
import { unlockedIdentity } from "../provision/local.js";
import type { RemoteContext } from "../provision/remote.js";
import { connectSsh } from "../provision/ssh.js";
import type { Sump } from "../sump/client.js";
import type { IpcEventLike, IpcMainLike } from "../sump/ipc.js";
import { login } from "../sump/login.js";

/** A secondary Sump, as its parent keeps it (the SSH plugin's `Secondary`). */
export interface Secondary {
  host: string;
  ssh_port: number;
  ssh_user: string;
  sump_port: number;
  owner: string;
  parent_user: string;
  promoted_at: number;
}

/** Whether the secondary joined the catalog, and as what, or why not. */
export type Joined = { ok: true; id: string; name: string } | { ok: false; message: string };

/** What Promote answers. */
export type PromoteResult =
  | { ok: true; secondary: Secondary; catalog: Joined }
  | { ok: false; message: string };

/** What promoting needs. */
export interface PromoteDeps {
  /** The window's Sump, or undefined when it has none. */
  sump: () => Sump | undefined;
  /** This app's user's public key (an OpenSSH line); throws when the vault is locked. */
  publicKey: () => string;
  /** POST to the Sump; throws its refusal. */
  post: (sump: Sump, path: string, body: unknown) => Promise<unknown>;
  /** Add the secondary to the catalog (a first connect); never throws. */
  join: (secondary: Secondary) => Promise<Joined>;
}

/** How long a promotion may take: the image may be pulled on the host. */
export const PROMOTE_TIMEOUT_MS = 15 * 60_000;

/** The catalog name of a secondary. */
export function secondaryName(secondary: Pick<Secondary, "host">): string {
  return `${secondary.host} (secondary)`;
}

/** The SSH target of a secondary, as the catalog keeps remote Sumps. */
export function secondaryTarget(secondary: Pick<Secondary, "ssh_user" | "host">): string {
  return secondary.ssh_user ? `${secondary.ssh_user}@${secondary.host}` : secondary.host;
}

/** A failure's words: the Sump's `detail` when it gave one. */
function said(error: unknown): string {
  const detail = (error as { detail?: { detail?: unknown } }).detail?.detail;
  return typeof detail === "string" ? detail : String((error as Error).message ?? error);
}

/** Promote `streamId` on the window's Sump; never throws. */
export async function promoteStream(deps: PromoteDeps, streamId: unknown): Promise<PromoteResult> {
  if (typeof streamId !== "string" || !streamId.startsWith("ssh:")) {
    return { ok: false, message: "only a data stream over SSH can be promoted" };
  }
  const sump = deps.sump();
  if (!sump) return { ok: false, message: "this window has no Sump" };
  let ownerKey: string;
  try {
    ownerKey = deps.publicKey();
  } catch (error) {
    return { ok: false, message: said(error) };
  }
  let secondary: Secondary;
  try {
    const answer = (await deps.post(sump, `/streams/${encodeURIComponent(streamId)}/promote`, {
      owner_key: ownerKey,
    })) as { secondary: Secondary };
    secondary = answer.secondary;
  } catch (error) {
    return { ok: false, message: said(error) };
  }
  return { ok: true, secondary, catalog: await deps.join(secondary) };
}

/** Add `secondary` to the catalog through a first connect; never throws. */
export async function joinCatalog(ctx: RemoteContext, secondary: Secondary): Promise<Joined> {
  const sshTarget = secondaryTarget(secondary);
  const host = secondary.host.toLowerCase();
  // Already one of your Sumps (promoted before, or added by hand): that one.
  const known = (ctx.catalog?.list() ?? []).find(
    (e) =>
      e.kind === "remote" &&
      (e.sshTarget ?? "").toLowerCase().replace(/^.*@/, "") === host &&
      e.sumpPort === secondary.sump_port,
  );
  if (known) return { ok: true, id: known.id, name: known.name };
  if (!ctx.forwards) return { ok: false, message: "no SSH forwards here" };
  const id = randomUUID();
  const name = secondaryName(secondary);
  try {
    const identity = unlockedIdentity(ctx);
    const ssh = {
      host: secondary.host,
      port: secondary.ssh_port,
      username: secondary.ssh_user,
      key: identity.key,
    };
    // This app's own way in: its key on the host, the host key pinned.
    const shell = await (ctx.connect ?? connectSsh)(ssh);
    const hostKey = shell.hostKey;
    shell.close();
    const forward = ctx.forwards.ensure({
      id,
      sumpPort: secondary.sump_port,
      ssh: { ...ssh, knownHostKey: hostKey },
    });
    if (!(await forward.waitUp(ctx.firstConnectTimeoutMs ?? 30_000))) {
      throw new Error(forward.lastError ?? "its SSH forward did not come up");
    }
    const user = userName(ctx.env);
    await login({ name: id, baseUrl: forward.url as string }, user, identity.key, ctx.tokens);
    ctx.catalog?.recordConnect({
      id,
      kind: "remote",
      name,
      sshTarget,
      sshPort: secondary.ssh_port,
      sumpPort: secondary.sump_port,
      user,
      hostKey,
      sshKeyId: "identity",
    });
    ctx.lifecycle.move(id, "active", `connected through SSH and logged in as ${user}`);
    ctx.afterConnect?.();
    return { ok: true, id, name };
  } catch (error) {
    ctx.forwards.stop(id);
    ctx.tokens.forget(id);
    const message = (error as Error).message ?? String(error);
    (ctx.logger ?? console).warn(`secondary on ${sshTarget} not added to the catalog: ${message}`);
    return { ok: false, message };
  }
}

export const PROMOTE_CHANNEL = "streams:promote";

/** Answer `streams:promote` with the calling window's deps. */
export function registerPromoteIpc(
  ipcMain: IpcMainLike,
  depsFor: (event: IpcEventLike) => PromoteDeps,
): void {
  ipcMain.handle(PROMOTE_CHANNEL, (event, message) =>
    promoteStream(depsFor(event), (message as { stream?: unknown } | undefined)?.stream),
  );
}
