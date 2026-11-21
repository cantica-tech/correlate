import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "../../catalog/catalog.js";
import { Lifecycle } from "../../catalog/lifecycle.js";
import { ActiveSumps } from "../../catalog/windows.js";
import { SessionTokens } from "../../sump/tokens.js";
import { Vault } from "../../vault/vault.js";
import { renameSump, replaceSshKey } from "../manage.js";
import { checkRemoteDetails } from "../plan.js";
import { type PendingSump, provisionRemote, type RemoteContext, sshKeyIdFor } from "../remote.js";
import type { RemoteShell, SshTarget } from "../ssh.js";

// br-SUMP-000002-sJpO9KMY and Edit (REQ-000015-sJpO9KMY Requirements 1 and 2).

const quiet = { info: () => {}, warn: () => {} };
let dir: string;
let catalog: Catalog;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "manage-test-"));
  catalog = Catalog.open(path.join(dir, "catalog.db"));
});
afterEach(() => {
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

const pem = () =>
  generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;

/** A host that accepts any command; `accept` decides whether a login works. */
function host(accept: (target: SshTarget) => boolean = () => true) {
  const logins: SshTarget[] = [];
  const connect = async (target: SshTarget): Promise<RemoteShell> => {
    logins.push(target);
    if (target.knownHostKey && target.knownHostKey !== "SHA256:host") {
      throw new Error("the host key changed");
    }
    if (!accept(target)) throw new Error("All configured authentication methods failed");
    return {
      hostKey: "SHA256:host",
      exec: async (command) => ({
        code: 0,
        // The health check, and the Docker socket's group (REQ-000024-sJpO9KMY).
        stdout: command.includes("python -c") ? "True\n" : command.includes("'%g'") ? "999\n" : "",
        stderr: "",
        timedOut: false,
      }),
      probePort: async () => "open" as const,
      close: () => {},
    };
  };
  return { connect, logins };
}

function context(connect: RemoteContext["connect"]): RemoteContext {
  const vault = new Vault(path.join(dir, "vault"), undefined, {
    scrypt: { N: 2 ** 10, r: 8, p: 1 },
    logger: quiet,
  });
  if (vault.state === "none") vault.create("a passphrase", "a passphrase");
  else vault.unlock("a passphrase");
  return {
    run: async () => ({ code: 0, stdout: "29\n", stderr: "", timedOut: false }),
    lifecycle: new Lifecycle(catalog, undefined, { info: () => {} }),
    tokens: new SessionTokens(),
    vault,
    env: { CORRELATE_USER: "olivier" },
    appVersion: "0.1.0",
    catalog,
    active: new ActiveSumps(catalog),
    connect,
    pending: new Map<string, PendingSump>(),
    healthTimeoutMs: 1_000,
    pollMs: 10,
    logger: quiet,
  };
}

describe("br-SUMP-000002-sJpO9KMY: New refuses only hosts with a live Sump", () => {
  it("refuses a host that has a live Sump, whatever the user, and points to Edit", async () => {
    catalog.recordConnect({ kind: "remote", sumpPort: 8765, sshTarget: "ops@Box", name: "box" });
    const ctx = context(host().connect);
    const result = await provisionRemote(ctx, checkRemoteDetails({ sshTarget: "root@box" }));
    expect(result).toMatchObject({ ok: false, step: "check" });
    expect(!result.ok && result.message).toContain("use Edit");
    expect(ctx.lifecycle.states()).toHaveLength(1);
  });

  it("refuses a host already being provisioned", async () => {
    const ctx = context(host().connect);
    const first = await provisionRemote(ctx, checkRemoteDetails({ sshTarget: "box" }));
    expect(first.ok).toBe(true);
    const second = await provisionRemote(ctx, checkRemoteDetails({ sshTarget: "ops@box" }));
    expect(second).toMatchObject({ ok: false, step: "check" });
  });

  it("accepts the same host on another Sump port, and a host whose Sump is retired", async () => {
    const old = catalog.recordConnect({ kind: "remote", sumpPort: 8765, sshTarget: "box" });
    const ctx = context(host().connect);
    expect(
      (await provisionRemote(ctx, checkRemoteDetails({ sshTarget: "box", sumpPort: 9000 }))).ok,
    ).toBe(true);
    ctx.lifecycle.move(old.id, "retired", "uninstalled");
    const again = await provisionRemote(ctx, checkRemoteDetails({ sshTarget: "box" }));
    expect(again.ok).toBe(true);
    expect(again.ok && again.id).not.toBe(old.id);
  });
});

describe("Edit (REQ-000015-sJpO9KMY Requirement 2)", () => {
  it("renames a live Sump, and refuses an empty name or a retired Sump", () => {
    const a = catalog.recordConnect({ kind: "remote", sumpPort: 8765, sshTarget: "box" });
    const ctx = context(host().connect);
    expect(renameSump(ctx, a.id, "  Lab  ")).toEqual({ ok: true, name: "Lab" });
    expect(renameSump(ctx, a.id, " ")).toMatchObject({ ok: false });
    catalog.retire(a.id);
    expect(renameSump(ctx, a.id, "Again")).toMatchObject({ ok: false });
  });

  it("replaces the SSH key only once the new key logs in", async () => {
    const a = catalog.recordConnect({
      kind: "remote",
      sumpPort: 8765,
      sshTarget: "ops@box",
      hostKey: "SHA256:host",
      sshKeyId: "identity",
    });
    const fresh = pem();
    const h = host();
    const ctx = context(h.connect);
    expect(await replaceSshKey(ctx, a.id, fresh)).toEqual({
      ok: true,
      sshKeyId: sshKeyIdFor(a.id),
    });
    expect(h.logins[0]).toMatchObject({
      host: "box",
      username: "ops",
      knownHostKey: "SHA256:host",
    });
    expect(ctx.vault?.get(sshKeyIdFor(a.id))).toBe(fresh);
    expect(catalog.get(a.id)?.sshKeyId).toBe(sshKeyIdFor(a.id));
  });

  it("keeps the working key when the new one is refused, or the host key changed", async () => {
    const working = pem();
    const a = catalog.recordConnect({
      kind: "remote",
      sumpPort: 8765,
      sshTarget: "box",
      hostKey: "SHA256:host",
      sshKeyId: "identity",
    });
    const ctx = context(host(() => false).connect);
    ctx.vault?.put(sshKeyIdFor(a.id), working);
    const refused = await replaceSshKey(ctx, a.id, pem());
    expect(refused).toMatchObject({ ok: false, step: "log in with the new key" });
    expect(ctx.vault?.get(sshKeyIdFor(a.id))).toBe(working);
    expect(catalog.get(a.id)?.sshKeyId).toBe("identity");
    catalog.amend(a.id, { hostKey: "SHA256:other" });
    const moved = await replaceSshKey(context(host().connect), a.id, pem());
    expect(moved).toMatchObject({ ok: false, message: "the host key changed" });
  });
});
