/**
 * The calls the Phase 4 screens use to add and manage Sumps: `sump:plan`,
 * `sump:provisionLocal`, `sump:provisionRemote` (REQ-000014-sJpO9KMY), and
 * `sump:list`, `sump:rename`, `sump:replaceKey`, `sump:switch`,
 * `sump:uninstall` (REQ-000015-sJpO9KMY), and `sump:audit`
 * (REQ-000017-sJpO9KMY).
 * Each answers with a result object and never throws; the calling window is
 * the one a new Sump may become active in, and only when the call asks for
 * it (`switchTo`), once the Sump is connected (cttc BUG-000006-uKKrzikI).
 */
import type { IpcEventLike, IpcMainLike } from "../sump/ipc.js";
import { provisionLocal } from "./local.js";
import { renameSump, replaceSshKey, switchSump, uninstallSump } from "./manage.js";
import { checkRemoteDetails, DetailsError, startupPlan } from "./plan.js";
import { provisionRemote, type RemoteContext } from "./remote.js";

export const PLAN_CHANNEL = "sump:plan";
export const PROVISION_LOCAL_CHANNEL = "sump:provisionLocal";
export const PROVISION_REMOTE_CHANNEL = "sump:provisionRemote";
export const LIST_CHANNEL = "sump:list";
export const RENAME_CHANNEL = "sump:rename";
export const REPLACE_KEY_CHANNEL = "sump:replaceKey";
export const SWITCH_CHANNEL = "sump:switch";
export const UNINSTALL_CHANNEL = "sump:uninstall";
export const AUDIT_CHANNEL = "sump:audit";

/** Answer the provisioning calls with `ctx`. */
export function registerProvisionIpc(ipcMain: IpcMainLike, ctx: RemoteContext): void {
  const windowOf = (event: IpcEventLike) => event?.sender?.id;
  ipcMain.handle(PLAN_CHANNEL, () => startupPlan(ctx.catalog, ctx.run));
  /** After a new Sump's first connect, audit the others (br-SUMP-000005-sJpO9KMY). */
  const audited = <T extends { ok: boolean }>(result: T): T => {
    if (result.ok) ctx.afterConnect?.();
    return result;
  };
  ipcMain.handle(PROVISION_LOCAL_CHANNEL, async (event, message) => {
    const m = (message ?? {}) as { switchTo?: unknown; confirmed?: unknown };
    return audited(
      await provisionLocal(ctx, {
        windowId: windowOf(event),
        switchTo: m.switchTo === true,
        confirmed: m.confirmed === true,
      }),
    );
  });
  ipcMain.handle(AUDIT_CHANNEL, async () => {
    if (!ctx.audit) return { ok: false, step: "check", message: "no audit here" };
    return { ok: true, results: await ctx.audit() };
  });
  // The Sumps a picker shows: live catalog Sumps with their lifecycle state
  // and whether the calling window is on them (br-SUMP-000010-sJpO9KMY).
  ipcMain.handle(LIST_CHANNEL, (event) => {
    const current = ctx.active?.get(windowOf(event) ?? -1);
    return (ctx.catalog?.list() ?? []).map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      sshTarget: e.sshTarget,
      sshPort: e.sshPort,
      sumpPort: e.sumpPort,
      // Where a remote Sump is reached on this machine: its forward.
      forwardUrl: e.kind === "remote" ? ctx.forwards?.urlOf(e.id) : undefined,
      state: ctx.lifecycle.get(e.id)?.state ?? "unreachable",
      current: e.id === current,
    }));
  });
  ipcMain.handle(RENAME_CHANNEL, (_event, message) => {
    const m = (message ?? {}) as { id?: unknown; name?: unknown };
    return renameSump(ctx, String(m.id ?? ""), m.name);
  });
  ipcMain.handle(REPLACE_KEY_CHANNEL, (_event, message) => {
    const m = (message ?? {}) as { id?: unknown; keyPem?: unknown };
    if (typeof m.keyPem !== "string")
      return { ok: false, step: "check", message: "keyPem is needed" };
    return replaceSshKey(ctx, String(m.id ?? ""), m.keyPem);
  });
  ipcMain.handle(SWITCH_CHANNEL, (event, message) => {
    const m = (message ?? {}) as { id?: unknown; confirmed?: unknown };
    const window = windowOf(event);
    if (window === undefined) return { ok: false, step: "check", message: "no window" };
    return switchSump(ctx, window, String(m.id ?? ""), { confirmed: m.confirmed === true });
  });
  ipcMain.handle(UNINSTALL_CHANNEL, (_event, message) => {
    const m = (message ?? {}) as { id?: unknown; confirmed?: unknown };
    return uninstallSump(ctx, String(m.id ?? ""), { confirmed: m.confirmed === true });
  });
  ipcMain.handle(PROVISION_REMOTE_CHANNEL, async (event, message) => {
    const m = (message ?? {}) as { keyPem?: unknown; switchTo?: unknown; confirmed?: unknown };
    try {
      const details = checkRemoteDetails(message);
      const keyPem = typeof m.keyPem === "string" && m.keyPem.trim() ? m.keyPem : undefined;
      return audited(
        await provisionRemote(ctx, details, {
          keyPem,
          windowId: windowOf(event),
          switchTo: m.switchTo === true,
          confirmed: m.confirmed === true,
        }),
      );
    } catch (error) {
      if (error instanceof DetailsError)
        return { ok: false, step: "check", message: error.message };
      return { ok: false, step: "provision", message: (error as Error).message };
    }
  });
}
