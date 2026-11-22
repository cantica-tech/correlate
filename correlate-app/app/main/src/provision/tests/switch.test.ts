import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "../../catalog/catalog.js";
import { Lifecycle } from "../../catalog/lifecycle.js";
import { ActiveSumps } from "../../catalog/windows.js";
import { neverAnswers, serve, type TestServer } from "../../sump/tests/servers.js";
import { SessionTokens } from "../../sump/tokens.js";
import { Vault } from "../../vault/vault.js";
import { LOCAL_PROJECT, provisionLocal } from "../local.js";
import { switchSump, uninstallSump } from "../manage.js";
import { type PendingSump, type RemoteContext, sshKeyIdFor } from "../remote.js";
import type { CommandResult } from "../runner.js";
import type { RemoteShell, SshTarget } from "../ssh.js";

// br-SUMP-000003-sJpO9KMY, br-SUMP-000004-sJpO9KMY and the recording check
// (REQ-000015-sJpO9KMY Requirements 3 to 5).

const quiet = { info: () => {}, warn: () => {} };
const ok: CommandResult = { code: 0, stdout: "", stderr: "", timedOut: false };
let dir: string;
let catalog: Catalog;
const servers: TestServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "switch-test-"));
  catalog = Catalog.open(path.join(dir, "catalog.db"));
});
afterEach(async () => {
  catalog.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  rmSync(dir, { recursive: true, force: true });
});

async function answering() {
  const s = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"ok","redis":true}');
  });
  servers.push(s);
  return s;
}

function context(extra: Partial<RemoteContext> = {}): RemoteContext & { commands: string[][] } {
  const vault = new Vault(path.join(dir, "vault"), undefined, {
    scrypt: { N: 2 ** 10, r: 8, p: 1 },
    logger: quiet,
  });
  if (vault.state === "none") vault.create("a passphrase", "a passphrase");
  else vault.unlock("a passphrase");
  const commands: string[][] = [];
  return {
    commands,
    run: async (command, args) => {
      commands.push([command, ...args]);
      return ok;
    },
    lifecycle: new Lifecycle(catalog, undefined, { info: () => {} }),
    tokens: new SessionTokens(),
    vault,
    env: { CORRELATE_USER: "olivier" },
    appVersion: "0.1.0",
    catalog,
    active: new ActiveSumps(catalog),
    pending: new Map<string, PendingSump>(),
    localDir: path.join(dir, "local"),
    logger: quiet,
    ...extra,
  };
}

describe("br-SUMP-000003-sJpO9KMY: a switch moves a window only to a Sump that answers", () => {
  it("moves the asking window, and no other, once the target answers", async () => {
    const up = await answering();
    const target = catalog.recordConnect({ kind: "remote", sumpPort: 1, sshTarget: "other" });
    const ctx = context({ resolve: (id) => (id === target.id ? up.sump : undefined) });
    ctx.active?.open(1);
    ctx.active?.open(2);
    expect(await switchSump(ctx, 1, target.id)).toEqual({ ok: true, id: target.id });
    expect([ctx.active?.get(1), ctx.active?.get(2)]).toEqual([target.id, "local"]);
    expect(ctx.lifecycle.get(target.id)?.state).toBe("active");
  });

  it.each([
    ["silent", "reach the Sump"],
    ["not reachable yet", "reach the Sump"],
    ["retired", "check"],
  ])(
    "keeps the window and its token when the target is %s",
    async (kind, step) => {
      const silent = await serve(neverAnswers);
      servers.push(silent);
      const target = catalog.recordConnect({ kind: "remote", sumpPort: 1, sshTarget: "other" });
      const ctx = context({
        resolve: (id) => (kind === "silent" && id === target.id ? silent.sump : undefined),
      });
      if (kind === "retired") ctx.lifecycle.move(target.id, "retired", "uninstalled");
      ctx.active?.open(1);
      ctx.tokens.set("local", "working");
      const original = setTimeout;
      const result = await switchSump(ctx, 1, target.id);
      expect(original).toBe(setTimeout);
      expect(result).toMatchObject({ ok: false, step });
      expect(ctx.active?.get(1)).toBe("local");
      expect(ctx.tokens.get("local")).toBe("working");
    },
    15_000,
  );
});

/** A host recording each command; `downFails` makes the uninstall fail. */
function host(downFails = false, containerLeft = true) {
  const commands: string[] = [];
  const logins: SshTarget[] = [];
  const connect = async (target: SshTarget): Promise<RemoteShell> => {
    logins.push(target);
    return {
      hostKey: "SHA256:host",
      exec: async (command) => {
        commands.push(command);
        if (downFails && command.includes(" down "))
          return { code: 1, stdout: "", stderr: "busy", timedOut: false };
        if (command.endsWith(" ps -q")) return { ...ok, stdout: containerLeft ? "abc123\n" : "" };
        return ok;
      },
      probePort: async () => "open" as const,
      close: () => {},
    };
  };
  return { connect, commands, logins };
}

describe("br-SUMP-000004-sJpO9KMY: uninstall fully removes a Sump", () => {
  it("asks for a confirmation that names what will be lost, and does nothing", async () => {
    catalog.recordConnect({ kind: "local", sumpPort: 8765 });
    const ctx = context();
    const result = await uninstallSump(ctx, "local");
    expect(result).toMatchObject({ ok: false, step: "confirm" });
    expect(!result.ok && result.message).toContain("its data");
    expect(ctx.commands).toEqual([]);
  });

  it("removes a local Sump, its token, and moves its windows to the latest active Sump", async () => {
    catalog.recordConnect({ kind: "local", sumpPort: 8765 }, new Date("2026-11-21T09:00:00Z"));
    const a = catalog.recordConnect(
      { kind: "remote", sumpPort: 1, sshTarget: "a" },
      new Date("2026-11-21T10:00:00Z"),
    );
    const b = catalog.recordConnect(
      { kind: "remote", sumpPort: 1, sshTarget: "b" },
      new Date("2026-11-21T11:00:00Z"),
    );
    const ctx = context();
    ctx.lifecycle.reachable(a.id, "up");
    ctx.lifecycle.reachable(b.id, "up");
    ctx.lifecycle.unreachable(b.id, "down");
    ctx.active?.open(1);
    ctx.active?.open(2);
    ctx.active?.set(2, a.id);
    ctx.tokens.set("local", "t");
    const result = await uninstallSump(ctx, "local", { confirmed: true });
    expect(result).toEqual({ ok: true, id: "local", movedTo: a.id });
    expect(ctx.commands).toEqual([
      [
        "docker",
        "compose",
        "-f",
        path.join(dir, "local", "docker-compose.yml"),
        "-p",
        LOCAL_PROJECT,
        "down",
        "-v",
        "--rmi",
        "all",
      ],
    ]);
    expect(catalog.get("local")?.retiredAt).toBeDefined();
    expect(ctx.lifecycle.get("local")?.state).toBe("retired");
    expect(ctx.tokens.get("local")).toBeUndefined();
    expect([ctx.active?.get(1), ctx.active?.get(2)]).toEqual([a.id, a.id]);
  });

  it("puts windows on no Sump when none other is active", async () => {
    catalog.recordConnect({ kind: "local", sumpPort: 8765 });
    const ctx = context();
    ctx.active?.open(1);
    await uninstallSump(ctx, "local", { confirmed: true });
    expect(ctx.active?.describe(1)).toBeNull();
    const fresh = new ActiveSumps(catalog);
    expect(fresh.open(9)).toBeNull();
  });

  it("removes a remote Sump over SSH, its install folder and its own key", async () => {
    const h = host();
    const a = catalog.recordConnect({
      kind: "remote",
      sumpPort: 8765,
      sshTarget: "ops@box",
      hostKey: "SHA256:host",
      sshKeyId: "identity",
    });
    const ctx = context({ connect: h.connect });
    const { generateKeyPairSync } = await import("node:crypto");
    const keyPem = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    ctx.vault?.put("identity", keyPem);
    ctx.vault?.put(sshKeyIdFor(a.id), keyPem);
    catalog.amend(a.id, { sshKeyId: sshKeyIdFor(a.id) });
    const result = await uninstallSump(ctx, a.id, { confirmed: true });
    expect(result).toMatchObject({ ok: true, id: a.id });
    expect(h.logins[0]).toMatchObject({
      host: "box",
      username: "ops",
      knownHostKey: "SHA256:host",
    });
    expect(h.commands).toEqual([
      "docker compose -f ~/.correlate-sump/docker-compose.yml -p correlate-sump down -v --rmi all && rm -rf ~/.correlate-sump",
    ]);
    expect(ctx.vault?.has(sshKeyIdFor(a.id))).toBe(false);
    expect(ctx.vault?.has("identity")).toBe(true);
  });

  it.each([
    [true, true],
    [true, false],
  ])(
    "on failure retires nothing and says whether the container remains (%s, %s)",
    async (_fails, left) => {
      const h = host(true, left);
      const a = catalog.recordConnect({
        kind: "remote",
        sumpPort: 8765,
        sshTarget: "box",
        hostKey: "SHA256:host",
      });
      const ctx = context({ connect: h.connect });
      const { generateKeyPairSync } = await import("node:crypto");
      ctx.vault?.put(
        "identity",
        generateKeyPairSync("ed25519").privateKey.export({
          type: "pkcs8",
          format: "pem",
        }) as string,
      );
      const result = await uninstallSump(ctx, a.id, { confirmed: true });
      expect(result).toMatchObject({ ok: false, step: "remove the Sump", containerRemains: left });
      expect(catalog.get(a.id)?.retiredAt).toBeUndefined();
    },
  );
});

describe("cttc BUG-000029 territory: every switch asks first while a recording is live", () => {
  const recording = { liveRecording: () => "night run" };

  it("asks before Switch, provisioning with switchTo, and uninstalling a window's Sump", async () => {
    const up = await answering();
    const target = catalog.recordConnect({ kind: "remote", sumpPort: 1, sshTarget: "other" });
    catalog.recordConnect({ kind: "local", sumpPort: 8765 });
    const ctx = context({ guard: recording, resolve: () => up.sump });
    ctx.active?.open(1);
    expect(await switchSump(ctx, 1, target.id)).toMatchObject({ ok: false, step: "confirm" });
    expect(await provisionLocal(ctx, { windowId: 1, switchTo: true })).toMatchObject({
      step: "confirm",
    });
    const uninstall = await uninstallSump(ctx, "local");
    expect(!uninstall.ok && uninstall.message).toContain(
      "The recording night run will be abandoned",
    );
    expect(ctx.active?.get(1)).toBe("local");
    expect(await switchSump(ctx, 1, target.id, { confirmed: true })).toMatchObject({ ok: true });
  });

  it("abandons the live recording once a switch is confirmed, and only then (REQ-000039-sJpO9KMY)", async () => {
    const up = await answering();
    const target = catalog.recordConnect({ kind: "remote", sumpPort: 1, sshTarget: "other" });
    catalog.recordConnect({ kind: "local", sumpPort: 8765 });
    let live: string | undefined = "paused";
    let abandoned = 0;
    const guard = {
      liveRecording: () => live,
      abandon: async () => {
        abandoned++;
        live = undefined;
      },
    };
    const ctx = context({ guard, resolve: () => up.sump });
    ctx.active?.open(1);
    await switchSump(ctx, 1, target.id);
    expect(abandoned).toBe(0);
    expect(await switchSump(ctx, 1, target.id, { confirmed: true })).toMatchObject({ ok: true });
    expect(abandoned).toBe(1);
    // Nothing live: a confirmed switch abandons nothing.
    expect(await switchSump(ctx, 1, "local", { confirmed: true })).toMatchObject({ ok: true });
    expect(abandoned).toBe(1);
  });
});
