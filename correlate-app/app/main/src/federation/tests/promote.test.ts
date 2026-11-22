import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "../../catalog/catalog.js";
import { Lifecycle } from "../../catalog/lifecycle.js";
import { ActiveSumps } from "../../catalog/windows.js";
import { LOGIN_NAMESPACE, privateKeyFrom } from "../../identity/sshkey.js";
import { unlockedIdentity } from "../../provision/local.js";
import type { PendingSump, RemoteContext } from "../../provision/remote.js";
import type { Sump } from "../../sump/client.js";
import { SumpHttpError } from "../../sump/errors.js";
import { Forwards } from "../../sump/forward.js";
import { serve, type TestServer } from "../../sump/tests/servers.js";
import { healthyHost, type SshHost, sshHost } from "../../sump/tests/sshhost.js";
import { SessionTokens } from "../../sump/tokens.js";
import { Vault } from "../../vault/vault.js";
import {
  joinCatalog,
  type PromoteDeps,
  promoteStream,
  type Secondary,
  secondaryName,
} from "../promote.js";

// br-FED-000001 and br-FED-000004-sJpO9KMY (REQ-000052-sJpO9KMY step 4):
// Promote… from the app, and the secondary joining the catalog through this
// app's own first connect, end to end with an SSH host in this process.

const quiet = { info: () => {}, warn: () => {} };
let dir: string;
let catalog: Catalog;
const cleanups: (() => unknown)[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "promote-test-"));
  catalog = Catalog.open(path.join(dir, "catalog.db"));
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

const SECONDARY: Secondary = {
  host: "127.0.0.1",
  ssh_port: 22,
  ssh_user: "ops",
  sump_port: 8775,
  owner: "olivier",
  parent_user: "parent-sump",
  promoted_at: 1_795_000_000_000,
};

function deps(overrides: Partial<PromoteDeps> = {}): PromoteDeps & { posted: unknown[] } {
  const posted: unknown[] = [];
  return {
    posted,
    sump: () => ({ name: "local", baseUrl: "http://127.0.0.1:1" }) as Sump,
    publicKey: () => "ssh-ed25519 AAAA olivier@correlate-app",
    post: async (_sump, p, body) => {
      posted.push([p, body]);
      return { secondary: SECONDARY };
    },
    join: async () => ({ ok: true, id: "s-1", name: secondaryName(SECONDARY) }),
    ...overrides,
  };
}

describe("br-FED-000001-sJpO9KMY: Promote… from the app", () => {
  it("sends this user's public key and says where the secondary joined", async () => {
    const d = deps();
    const result = await promoteStream(d, "ssh:ops@127.0.0.1:22");
    expect(d.posted).toEqual([
      [
        "/streams/ssh%3Aops%40127.0.0.1%3A22/promote",
        { owner_key: "ssh-ed25519 AAAA olivier@correlate-app" },
      ],
    ]);
    expect(result).toEqual({
      ok: true,
      secondary: SECONDARY,
      catalog: { ok: true, id: "s-1", name: "127.0.0.1 (secondary)" },
    });
  });

  it("refuses what cannot be promoted, and says the Sump's refusal", async () => {
    expect(await promoteStream(deps(), "self")).toMatchObject({ ok: false });
    expect(await promoteStream(deps({ sump: () => undefined }), "ssh:a@b:22")).toEqual({
      ok: false,
      message: "this window has no Sump",
    });
    const locked = deps({
      publicKey: () => {
        throw new Error("the key vault is locked");
      },
    });
    expect(await promoteStream(locked, "ssh:a@b:22")).toEqual({
      ok: false,
      message: "the key vault is locked",
    });
    const refused = deps({
      post: async () => {
        throw new SumpHttpError("local", "POST", "/streams/ssh:a@b:22/promote", 409, {
          detail: "check: this data stream is already promoted",
        });
      },
    });
    expect(await promoteStream(refused, "ssh:a@b:22")).toEqual({
      ok: false,
      message: "check: this data stream is already promoted",
    });
  });
});

/** A fake secondary: /health, the challenge and a login answering `loginStatus`. */
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
      return json(404, {});
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
    env: { CORRELATE_USER: "olivier" },
    appVersion: "0.1.0",
    catalog,
    active: new ActiveSumps(catalog),
    pending: new Map<string, PendingSump>(),
    forwards,
    firstConnectTimeoutMs: 5_000,
    logger: quiet,
  };
}

async function hostFor(ctx: RemoteContext, key = unlockedIdentity(ctx).key): Promise<SshHost> {
  const host = await sshHost(key, healthyHost);
  cleanups.push(() => host.close());
  return host;
}

describe("br-FED-000004-sJpO9KMY: the secondary joins the catalog", () => {
  it("through this app's own SSH access, its host key pinned, logged in", async () => {
    const sump = await fakeSump();
    const ctx = context();
    const host = await hostFor(ctx);
    const sumpPort = Number(new URL(sump.sump.baseUrl).port);
    const secondary = { ...SECONDARY, ssh_port: host.port, sump_port: sumpPort };
    const joined = await joinCatalog(ctx, secondary);
    expect(joined, JSON.stringify(joined)).toMatchObject({
      ok: true,
      name: "127.0.0.1 (secondary)",
    });
    if (!joined.ok) return;
    const entry = catalog.get(joined.id);
    expect(entry).toMatchObject({
      kind: "remote",
      name: "127.0.0.1 (secondary)",
      sshTarget: "ops@127.0.0.1",
      sshPort: host.port,
      sumpPort,
      user: "olivier",
      sshKeyId: "identity",
    });
    expect(entry?.hostKey).toMatch(/^SHA256:/);
    expect(ctx.lifecycle.get(joined.id)?.state).toBe("active");
    expect(host.forwarded).toContain(sumpPort);
    // Promoting again finds it there.
    expect(await joinCatalog(ctx, secondary)).toEqual(joined);
  }, 30_000);

  it("is not added when this app's key is not on the host, and says why", async () => {
    const sump = await fakeSump();
    const ctx = context();
    const other = privateKeyFrom(
      generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    );
    const host = await hostFor(ctx, other);
    const sumpPort = Number(new URL(sump.sump.baseUrl).port);
    const joined = await joinCatalog(ctx, {
      ...SECONDARY,
      ssh_port: host.port,
      sump_port: sumpPort,
    });
    expect(joined.ok).toBe(false);
    expect(catalog.list()).toEqual([]);
  }, 30_000);

  it("is not added when its login is refused; its forward stops", async () => {
    const sump = await fakeSump(401);
    const ctx = context();
    const host = await hostFor(ctx);
    const sumpPort = Number(new URL(sump.sump.baseUrl).port);
    const joined = await joinCatalog(ctx, {
      ...SECONDARY,
      ssh_port: host.port,
      sump_port: sumpPort,
    });
    expect(joined).toMatchObject({ ok: false });
    expect(catalog.list()).toEqual([]);
    expect(ctx.forwards.urlOf("anything")).toBeUndefined();
  }, 30_000);
});
