/**
 * The provisioning calls the Phase 4 screens use (REQ-000014-sJpO9KMY
 * Requirement 6): `sump:plan`, `sump:provisionLocal`, `sump:provisionRemote`.
 * Each answers with a result object and never throws; the calling window is
 * the one a new Sump may become active in, and only when the call asks for
 * it (`switchTo`), once the Sump is connected (cttc BUG-000006-uKKrzikI).
 */
import type { IpcEventLike, IpcMainLike } from "../sump/ipc.js";
import { provisionLocal } from "./local.js";
import { checkRemoteDetails, DetailsError, startupPlan } from "./plan.js";
import { provisionRemote, type RemoteContext } from "./remote.js";

export const PLAN_CHANNEL = "sump:plan";
export const PROVISION_LOCAL_CHANNEL = "sump:provisionLocal";
export const PROVISION_REMOTE_CHANNEL = "sump:provisionRemote";

/** Answer the provisioning calls with `ctx`. */
export function registerProvisionIpc(ipcMain: IpcMainLike, ctx: RemoteContext): void {
  const windowOf = (event: IpcEventLike) => event?.sender?.id;
  ipcMain.handle(PLAN_CHANNEL, () => startupPlan(ctx.catalog, ctx.run));
  ipcMain.handle(PROVISION_LOCAL_CHANNEL, (event, message) => {
    const m = (message ?? {}) as { switchTo?: unknown };
    return provisionLocal(ctx, { windowId: windowOf(event), switchTo: m.switchTo === true });
  });
  ipcMain.handle(PROVISION_REMOTE_CHANNEL, async (_event, message) => {
    const m = (message ?? {}) as { keyPem?: unknown };
    try {
      const details = checkRemoteDetails(message);
      const keyPem = typeof m.keyPem === "string" && m.keyPem.trim() ? m.keyPem : undefined;
      return await provisionRemote(ctx, details, { keyPem });
    } catch (error) {
      if (error instanceof DetailsError)
        return { ok: false, step: "check", message: error.message };
      return { ok: false, step: "provision", message: (error as Error).message };
    }
  });
}
