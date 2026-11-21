import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "../../catalog/catalog.js";
import { Lifecycle } from "../../catalog/lifecycle.js";
import { ActiveSumps } from "../../catalog/windows.js";
import { LOGIN_NAMESPACE } from "../../identity/sshkey.js";
import { configuredSumps } from "../../index.js";
import { Forwards } from "../../sump/forward.js";
import { handleSumpRequest } from "../../sump/ipc.js";
import { serve, type TestServer } from "../../sump/tests/servers.js";
import { healthyHost, type SshHost, sshHost } from "../../sump/tests/sshhost.js";
import { SessionTokens } from "../../sump/tokens.js";
import { Vault } from "../../vault/vault.js";
import { checkComposeLoopback, composeFile, unlockedIdentity } from "../local.js";
import { uninstallSump } from "../manage.js";
import { checkRemoteDetails } from "../plan.js";
import { type PendingSump, provisionRemote, type RemoteContext, sshKeyIdFor } from "../remote.js";

// br-SUMP-000007-sJpO9KMY, br-SUMP-000009-sJpO9KMY, br-SUMP-000010-sJpO9KMY
// (REQ-000016-sJpO9KMY Requirements 2 to 4): a remote Sump provisioned over
// SSH and reached through its forward, end to end with an SSH host in this
// process.

const quiet = { info: () => {}, warn: () => {} };
let dir: string;
let catalog: Catalog;
const cleanups: (() => unknown)[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "firstconnect-test-"));
  catalog = Catalog.open(path.join(dir, "catalog.db"));
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake Sump: /health, the challenge, and a login answering `loginStatus`. */
async function fakeSump(loginStatus = 200): Promise<TestServer> {
  const s = await serve((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/health") return json(200, { status: "ok", redis: true });
      if (req.url === "/session/challenge") {
        return json(200, { challenge: "c", namespace: LOGIN_NAMESPACE, expires_in: 60 });
      }
      if (req.url === "/session/login") {
        return loginStatus === 200
          ? json(200, { token: "t", user: JSON.parse(body).user, owner: true })
          : json(401, { detail: "login refused" });
      }
      return json(200, { path: req.url, authorized: req.headers.authorization === "Bearer t" });
    });
  });
  cleanups.push(() => s.close());
  return s;
}

function context(): RemoteContext & { forwards: Forwards } {
  const vault = new Vault(path.join(dir, "vault"), undefined, {
    scrypt: { N: 2 ** 10, r: 8, p: 1 },
    logger: quiet,
  });
  vault.create("a passphrase", "a passphrase");
  const lifecycle = new Lifecycle(catalog, undefined, { info: () => {} });
  const forwards = new Forwards({ lifecycle, baseDelayMs: 50, maxDelayMs: 200, logger: quiet });
  cleanups.push(() => forwards.stopAll());
  return {
    run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    lifecycle,
    tokens: new SessionTokens(),
    vault,
    env: { CORRELATE_USER: "olivier", CORRELATE_SUMP_IMAGE: "correlate-sump:dev" },
    appVersion: "0.1.0",
    catalog,
    active: new ActiveSumps(catalog),
    pending: new Map<string, PendingSump>(),
    forwards,
    pollMs: 10,
    firstConnectTimeoutMs: 5_000,
    logger: quiet,
  };
}

async function hostFor(ctx: RemoteContext, key = unlockedIdentity(ctx).key): Promise<SshHost> {
  const host = await sshHost(key, healthyHost);
  cleanups.push(() => host.close());
  return host;
}

describe("br-SUMP-000007-sJpO9KMY: a remote Sump's first connect", () => {
  it("provisions, connects through the forward, logs in, records and switches", async () => {
    const sump = await fakeSump();
    const ctx = context();
    const host = await hostFor(ctx);
    ctx.active?.open(1);
    const sumpPort = Number(new URL(sump.sump.baseUrl).port);
    const details = checkRemoteDetails({
      sshTarget: "ops@127.0.0.1",
      sshPort: host.port,
      sumpPort,
    });
    const result = await provisionRemote(ctx, details, { windowId: 1, switchTo: true });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, switched: true });
    if (!result.ok) return;
    const entry = catalog.get(result.id);
    expect(entry).toMatchObject({
      kind: "remote",
      sshTarget: "ops@127.0.0.1",
      user: "olivier",
      sshKeyId: "identity",
    });
    expect(entry?.hostKey).toMatch(/^SHA256:/);
    expect(ctx.lifecycle.get(result.id)?.state).toBe("active");
    expect(ctx.active?.get(1)).toBe(result.id);
    expect(host.forwarded).toContain(sumpPort);
    // Every call to it goes through the forward, with its token.
    const resolve = configuredSumps({}, ctx.tokens, catalog, ctx.forwards);
    const reply = await handleSumpRequest(
      { sump: result.id, method: "GET", path: "/records" },
      resolve,
      ctx.tokens,
    );
    expect(reply).toEqual({ ok: true, value: { path: "/records", authorized: true } });
    expect(new URL(resolve(result.id)?.baseUrl as string).port).not.toBe(String(sumpPort));
    // Uninstall closes its forward.
    expect((await uninstallSump(ctx, result.id, { confirmed: true })).ok).toBe(true);
    expect(ctx.forwards.urlOf(result.id)).toBeUndefined();
    expect(resolve(result.id)).toBeUndefined();
  }, 30_000);

  it("retires the Sump, stops its forward and deletes its key when the first login fails", async () => {
    const sump = await fakeSump(401);
    const ctx = context();
    const sshKeyPem = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    const { privateKeyFrom } = await import("../../identity/sshkey.js");
    const host = await hostFor(ctx, privateKeyFrom(sshKeyPem));
    ctx.active?.open(1);
    const details = checkRemoteDetails({
      sshTarget: "ops@127.0.0.1",
      sshPort: host.port,
      sumpPort: Number(new URL(sump.sump.baseUrl).port),
    });
    const result = await provisionRemote(ctx, details, {
      keyPem: sshKeyPem,
      windowId: 1,
      switchTo: true,
    });
    expect(result).toMatchObject({ ok: false, step: "log in" });
    const [record] = ctx.lifecycle.states();
    expect(record?.state).toBe("retired");
    expect(ctx.forwards.urlOf(record?.id as string)).toBeUndefined();
    expect(ctx.vault?.has(sshKeyIdFor(record?.id as string))).toBe(false);
    expect(catalog.list({ retired: true })).toEqual([]);
    expect(ctx.active?.get(1)).toBe("local");
    expect(host.commands.at(-1)).toMatch(/ down$/);
  }, 30_000);
});

describe("br-SUMP-000009-sJpO9KMY: provisioning publishes on loopback only", () => {
  it("accepts the compose file the app writes", () => {
    expect(() => checkComposeLoopback(composeFile("img", 8765, 999))).not.toThrow();
  });

  it.each([
    ['    ports:\n      - "8765:8765"\n', "8765:8765"],
    ['    ports:\n      - "0.0.0.0:8765:8765"\n', "0.0.0.0"],
    ["    ports:\n      - 192.168.1.2:5140:5140\n", "192.168.1.2"],
    ["    network_mode: host\n", "host networking"],
  ])("refuses %j", (text, why) => {
    expect(() => checkComposeLoopback(`services:\n  sump:\n${text}`)).toThrow(why);
  });
});
