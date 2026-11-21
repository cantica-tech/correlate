import { describe, expect, it } from "vitest";
import { Lifecycle } from "../../catalog/lifecycle.js";
import { SessionTokens } from "../../sump/tokens.js";
import {
  PLAN_CHANNEL,
  PROVISION_LOCAL_CHANNEL,
  PROVISION_REMOTE_CHANNEL,
  registerProvisionIpc,
} from "../ipc.js";
import type { RemoteContext } from "../remote.js";

// REQ-000014-sJpO9KMY Requirement 6: the provisioning calls for the screens.

function setup(dockerUp: boolean) {
  const handlers = new Map<string, (event: unknown, message: unknown) => unknown>();
  const ctx: RemoteContext = {
    run: async () => ({
      code: dockerUp ? 0 : 1,
      stdout: dockerUp ? "29\n" : "",
      stderr: "",
      timedOut: false,
    }),
    lifecycle: new Lifecycle(undefined, undefined, { info: () => {} }),
    tokens: new SessionTokens(),
    vault: undefined,
    env: {},
    appVersion: "0.1.0",
    pending: new Map(),
    logger: { info: () => {}, warn: () => {} },
  };
  registerProvisionIpc(
    { handle: (channel, handler) => void handlers.set(channel, handler as never) },
    ctx,
  );
  const call = (channel: string, message?: unknown) =>
    (handlers.get(channel) as (e: unknown, m: unknown) => unknown)({ sender: { id: 1 } }, message);
  return { handlers, call };
}

describe("REQ-000014-sJpO9KMY: provisioning over the bridge", () => {
  it("answers the three channels", () => {
    expect([...setup(true).handlers.keys()].sort()).toEqual(
      [PLAN_CHANNEL, PROVISION_LOCAL_CHANNEL, PROVISION_REMOTE_CHANNEL].sort(),
    );
  });

  it("plans", async () => {
    expect(await setup(false).call(PLAN_CHANNEL)).toEqual({
      firstRun: true,
      docker: false,
      offers: ["remote"],
    });
  });

  it("refuses bad remote details as a result, not an exception", async () => {
    expect(
      await setup(true).call(PROVISION_REMOTE_CHANNEL, { sshTarget: "box; reboot" }),
    ).toMatchObject({
      ok: false,
      step: "check",
    });
  });

  it("reports a missing vault as the failed step", async () => {
    expect(await setup(true).call(PROVISION_LOCAL_CHANNEL, { switchTo: true })).toMatchObject({
      ok: false,
      step: "open the key vault",
    });
    expect(await setup(true).call(PROVISION_REMOTE_CHANNEL, { sshTarget: "box" })).toMatchObject({
      ok: false,
      step: "open the key vault",
    });
  });
});
