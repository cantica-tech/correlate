import { describe, expect, it } from "vitest";
import { Lifecycle } from "../../catalog/lifecycle.js";
import { SessionTokens } from "../../sump/tokens.js";
import {
  AUDIT_CHANNEL,
  LIST_CHANNEL,
  PLAN_CHANNEL,
  PROVISION_LOCAL_CHANNEL,
  PROVISION_REMOTE_CHANNEL,
  RENAME_CHANNEL,
  REPLACE_KEY_CHANNEL,
  registerProvisionIpc,
  SWITCH_CHANNEL,
  UNINSTALL_CHANNEL,
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

describe("REQ-000015-sJpO9KMY: managing Sumps over the bridge", () => {
  it("answers each manage call with a result, never an exception", async () => {
    const { call } = setup(true);
    expect(await call(LIST_CHANNEL)).toEqual([]);
    expect(await call(RENAME_CHANNEL, { id: "x", name: "y" })).toMatchObject({ ok: false });
    expect(await call(REPLACE_KEY_CHANNEL, { id: "x" })).toMatchObject({
      ok: false,
      step: "check",
    });
    expect(await call(SWITCH_CHANNEL, { id: "x" })).toMatchObject({ ok: false });
    expect(await call(UNINSTALL_CHANNEL, { id: "x" })).toMatchObject({ ok: false, step: "check" });
    expect(await call(AUDIT_CHANNEL)).toMatchObject({ ok: false, step: "check" });
  });
});

describe("REQ-000014-sJpO9KMY: provisioning over the bridge", () => {
  it("answers the three channels", () => {
    expect([...setup(true).handlers.keys()].sort()).toEqual(
      [
        PLAN_CHANNEL,
        PROVISION_LOCAL_CHANNEL,
        PROVISION_REMOTE_CHANNEL,
        LIST_CHANNEL,
        RENAME_CHANNEL,
        REPLACE_KEY_CHANNEL,
        SWITCH_CHANNEL,
        UNINSTALL_CHANNEL,
        AUDIT_CHANNEL,
      ].sort(),
    );
  });

  it("plans", async () => {
    expect(await setup(false).call(PLAN_CHANNEL)).toEqual({
      firstRun: true,
      docker: false,
      offers: ["remote"],
      notices: [expect.stringContaining("Docker socket")],
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
