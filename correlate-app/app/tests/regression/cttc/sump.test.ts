/**
 * Regression corpus of cttc's bugs: Sump management and transport (SUMP).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditSumps } from "../../../main/src/catalog/audit.js";
import { Catalog } from "../../../main/src/catalog/catalog.js";
import { Lifecycle } from "../../../main/src/catalog/lifecycle.js";
import { ActiveSumps } from "../../../main/src/catalog/windows.js";
import { configuredSumps } from "../../../main/src/index.js";
import { provisionLocal } from "../../../main/src/provision/local.js";
import { switchSump } from "../../../main/src/provision/manage.js";
import { checkRemoteDetails } from "../../../main/src/provision/plan.js";
import { provisionRemote } from "../../../main/src/provision/remote.js";
import { Forwards } from "../../../main/src/sump/forward.js";
import { handleSumpRequest } from "../../../main/src/sump/ipc.js";
import { serve } from "../../../main/src/sump/tests/servers.js";
import { sshHost } from "../../../main/src/sump/tests/sshhost.js";
import { SessionTokens } from "../../../main/src/sump/tokens.js";
import { Vault } from "../../../main/src/vault/vault.js";

/** A fake Sump answering every path with 200. */
async function answeringSump() {
  return serve((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, redis: true }));
  });
}

const quietLog = { info: () => {}, warn: () => {} };

describe("br-SUMP-000006-sJpO9KMY", () => {
  // BUG-000001-uKKrzikI, Critical (roadmap Item 18, RM-000019-sJpO9KMY): cttc
  // pasted a peer's host into a PowerShell command. The audit runs no shell
  // and no OS tool: a host full of quotes and commands reaches the SSH library
  // as one plain value, and nothing is executed.
  it("cttc BUG-000001: PowerShell command injection via peer gateway host", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cttc-inject-"));
    const hostile = "box';Remove-Item -Recurse C:\\;$(touch /tmp/pwned)'";
    try {
      const catalog = Catalog.open(path.join(dir, "catalog.db"));
      catalog.recordConnect({ kind: "remote", sumpPort: 8765, sshTarget: `ops@${hostile}` });
      const vault = new Vault(path.join(dir, "vault"), undefined, {
        scrypt: { N: 2 ** 10, r: 8, p: 1 },
        logger: quietLog,
      });
      vault.create("a passphrase", "a passphrase");
      vault.put(
        "identity",
        generateKeyPairSync("ed25519").privateKey.export({
          type: "pkcs8",
          format: "pem",
        }) as string,
      );
      const asked: string[] = [];
      const [result] = await auditSumps(
        {
          catalog,
          vault,
          connect: async (target) => {
            asked.push(target.host);
            throw new Error("no such host");
          },
        },
        { timeoutMs: 1_000 },
      );
      expect(asked).toEqual([hostile]);
      expect(result?.existence).toBe("unknown");
      const here = path.dirname(fileURLToPath(import.meta.url));
      const source = readFileSync(path.join(here, "../../../main/src/catalog/audit.ts"), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/child_process|powershell|telnet|\bnc\b|spawn|execFile/i);
      catalog.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("br-SUMP-000005-sJpO9KMY", () => {
  // BUG-000002-uKKrzikI, Medium (roadmap Item 18, RM-000019-sJpO9KMY): cttc's
  // telnet fallback held the connection open until its time-out and read the
  // time-out as "closed". Probes now never read an open port as closed: a port
  // that accepts but never answers is unknown, never absent, even for a Sump
  // confirmed before; only a refused connection can make it absent.
  it("cttc BUG-000002: Telnet fallback reports open ports as closed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cttc-telnet-"));
    const silent = await serve(() => {});
    try {
      const catalog = Catalog.open(path.join(dir, "catalog.db"));
      catalog.recordConnect({ kind: "local", sumpPort: Number(new URL(silent.sump.baseUrl).port) });
      const [result] = await auditSumps({ catalog }, { timeoutMs: 300 });
      expect(result?.existence).toBe("unknown");
      catalog.close();
    } finally {
      await silent.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("br-SUMP-000001-sJpO9KMY", () => {
  // BUG-000003-uKKrzikI, Critical (roadmap Item 13, RM-000014-sJpO9KMY): cttc
  // read a corrupt gateways.json as empty and the next save wrote over every
  // gateway. The catalog now refuses a corrupt file and leaves its bytes as
  // they were; recording a connect needs a catalog that opened.
  it("cttc BUG-000003: Corrupt gateways.json is silently overwritten", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cttc-catalog-"));
    const file = path.join(dir, "catalog.db");
    try {
      const catalog = Catalog.open(file);
      catalog.recordConnect({ kind: "remote", sumpPort: 8765, sshTarget: "ops@box" });
      catalog.close();
      const corrupt = Buffer.concat([readFileSync(file).subarray(0, 100), Buffer.from("{")]);
      writeFileSync(file, corrupt);
      expect(() => Catalog.open(file)).toThrow(expect.objectContaining({ code: "corrupt" }));
      expect(() => Catalog.open(file)).toThrow(expect.objectContaining({ code: "corrupt" }));
      expect(readFileSync(file).equals(corrupt)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("br-SUMP-000002-sJpO9KMY", () => {
  // BUG-000004-uKKrzikI, High (roadmap Item 16, RM-000017-sJpO9KMY): cttc's
  // duplicate check matched retired gateways too, so an uninstalled host could
  // never be added again. Now only a live Sump on the host refuses New; a
  // retired one is kept as history and the host is provisioned afresh.
  it("cttc BUG-000004: Uninstalled gateway's host can never be re-added", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cttc-readd-"));
    try {
      const catalog = Catalog.open(path.join(dir, "catalog.db"));
      const old = catalog.recordConnect({ kind: "remote", sumpPort: 8765, sshTarget: "box" });
      catalog.retire(old.id);
      const vault = new Vault(path.join(dir, "vault"), undefined, {
        scrypt: { N: 2 ** 10, r: 8, p: 1 },
        logger: { info: () => {}, warn: () => {} },
      });
      vault.create("a passphrase", "a passphrase");
      const result = await provisionRemote(
        {
          run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
          lifecycle: new Lifecycle(catalog, undefined, { info: () => {} }),
          tokens: new SessionTokens(),
          vault,
          env: { CORRELATE_USER: "olivier" },
          appVersion: "0.1.0",
          catalog,
          pending: new Map(),
          pollMs: 10,
          logger: { info: () => {}, warn: () => {} },
          connect: async () => ({
            hostKey: "SHA256:host",
            probePort: async () => "open" as const,
            exec: async (command: string) => ({
              code: 0,
              stdout: command.includes("python -c") ? "True\n" : "",
              stderr: "",
              timedOut: false,
            }),
            close: () => {},
          }),
        },
        checkRemoteDetails({ sshTarget: "box" }),
      );
      expect(result.ok).toBe(true);
      expect(catalog.list({ retired: true }).map((e) => e.id)).toEqual([old.id]);
      catalog.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("br-SUMP-000003-sJpO9KMY", () => {
  // BUG-000005-uKKrzikI, High (roadmap Items 16 and 17, RM-000017-sJpO9KMY,
  // RM-000018-sJpO9KMY): cttc closed the current tunnel before the new
  // connection succeeded. Forwards are now per Sump: a failed switch to
  // another remote Sump leaves the window on its Sump, whose forward still
  // carries calls.
  it("cttc BUG-000005: Failed switch to a remote gateway tears down the current tunnel", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cttc-switch-"));
    const key = generateKeyPairSync("ed25519").privateKey;
    const host = await sshHost(key);
    const sumpA = await answeringSump();
    const catalog = Catalog.open(path.join(dir, "catalog.db"));
    const lifecycle = new Lifecycle(catalog, undefined, { info: () => {} });
    const forwards = new Forwards({
      lifecycle,
      baseDelayMs: 50,
      maxDelayMs: 100,
      logger: quietLog,
    });
    try {
      const a = catalog.recordConnect({
        kind: "remote",
        sumpPort: Number(new URL(sumpA.sump.baseUrl).port),
        sshTarget: "a",
      });
      const b = catalog.recordConnect({ kind: "remote", sumpPort: 1, sshTarget: "b" });
      const ssh = { host: "127.0.0.1", port: host.port, username: "ops", key };
      expect(await forwards.ensure({ id: a.id, sumpPort: a.sumpPort, ssh }).waitUp(5_000)).toBe(
        true,
      );
      forwards.ensure({ id: b.id, sumpPort: 1, ssh: { ...ssh, port: 1 } });
      const tokens = new SessionTokens();
      const resolve = configuredSumps({}, tokens, catalog, forwards);
      const active = new ActiveSumps(catalog);
      active.open(1);
      active.set(1, a.id);
      const ctx = {
        run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
        lifecycle,
        tokens,
        vault: undefined,
        env: {},
        appVersion: "0.1.0",
        catalog,
        active,
        pending: new Map(),
        resolve,
        forwards,
        logger: quietLog,
      };
      expect(await switchSump(ctx, 1, b.id)).toMatchObject({ ok: false, step: "reach the Sump" });
      expect(active.get(1)).toBe(a.id);
      expect(forwards.urlOf(a.id)).toBeDefined();
      const call = await handleSumpRequest(
        { sump: a.id, method: "GET", path: "/records" },
        resolve,
      );
      expect(call).toEqual({ ok: true, value: { path: "/records", redis: true } });
    } finally {
      forwards.stopAll();
      host.close();
      await sumpA.close();
      catalog.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  // BUG-000006-uKKrzikI, Medium (roadmap Item 15, RM-000016-sJpO9KMY): cttc
  // switched the connection before asking, so "Later" left the window on a
  // dead one. Now a window moves to a new Sump only once it is connected and
  // only when asked: "Later" and a failed provisioning both leave it on its
  // Sump, with the Sump it was on still answering.
  it("cttc BUG-000006: Choosing 'Later' after adding a gateway leaves the window on a dead connection", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cttc-later-"));
    const sump = await serve((req, res) => {
      const json = (value: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/health") return json({ status: "ok", redis: true });
      if (req.url === "/session/challenge") {
        return json({ challenge: "c", namespace: "correlate-sump-login", expires_in: 60 });
      }
      return json({ token: "t", user: "olivier", owner: true });
    });
    try {
      const catalog = Catalog.open(path.join(dir, "catalog.db"));
      const current = catalog.recordConnect({
        kind: "remote",
        sumpPort: 8765,
        sshTarget: "current",
      });
      const vault = new Vault(path.join(dir, "vault"), undefined, {
        scrypt: { N: 2 ** 10, r: 8, p: 1 },
        logger: { info: () => {}, warn: () => {} },
      });
      vault.create("a passphrase", "a passphrase");
      const active = new ActiveSumps(catalog);
      active.open(1);
      active.set(1, current.id);
      const ctx = {
        run: async () => ({ code: 0, stdout: "29\n", stderr: "", timedOut: false }),
        lifecycle: new Lifecycle(catalog, undefined, { info: () => {} }),
        tokens: new SessionTokens(),
        vault,
        env: { CORRELATE_USER: "olivier" },
        appVersion: "0.1.0",
        catalog,
        active,
        localDir: path.join(dir, "local"),
        logger: { info: () => {}, warn: () => {} },
      };
      const port = Number(new URL(sump.sump.baseUrl).port);
      const later = await provisionLocal(ctx, { sumpPort: port, windowId: 1, switchTo: false });
      expect(later).toEqual({ ok: true, id: "local", switched: false });
      expect(active.get(1)).toBe(current.id);
      const failed = await provisionLocal(
        { ...ctx, run: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }) },
        { windowId: 1, switchTo: true },
      );
      expect(failed.ok).toBe(false);
      expect(active.get(1)).toBe(current.id);
      catalog.close();
    } finally {
      await sump.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  // BUG-000007-uKKrzikI, High (roadmap Item 10, RM-000011-sJpO9KMY): Edit
  // Gateway wrote the new key over the working one before connecting with it.
  // The vault now keeps the working key until the new one is proven
  // (br-VAULT-000007-sJpO9KMY); the Edit Sump flow itself comes with Phase 3.
  it("cttc BUG-000007: Edit Gateway overwrites the working key before the new one is proven", async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "cttc-sump-")), "vault");
    try {
      const pem = () =>
        generateKeyPairSync("ed25519").privateKey.export({
          type: "pkcs8",
          format: "pem",
        }) as string;
      const vault = new Vault(dir, undefined, {
        scrypt: { N: 2 ** 10, r: 8, p: 1 },
        logger: { info: () => {}, warn: () => {} },
      });
      vault.create("a passphrase", "a passphrase");
      const working = pem();
      vault.put("sump", working);
      await expect(
        vault.replace("sump", pem(), () => Promise.reject(new Error("connect failed"))),
      ).rejects.toThrow("connect failed");
      expect(vault.get("sump")).toBe(working);
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });
});

describe("br-SUMP-000008-sJpO9KMY", () => {
  // BUG-000008-uKKrzikI, High (roadmap Item 17, RM-000018-sJpO9KMY): cttc
  // killed every PID a previous run had recorded for its ssh tunnels, possibly
  // an unrelated process by then. The forward runs inside the app's own SSH
  // connection: no subprocess is started, so no PID is recorded or killed.
  it("cttc BUG-000008: Orphan cleanup can kill an unrelated process", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ["main/src/sump/forward.ts", "main/src/provision/ssh.ts"]) {
      const source = readFileSync(path.join(here, "../../..", file), "utf8");
      expect(source).not.toMatch(
        /child_process|\bspawn\(|\bexec(File)?Sync\(|process\.kill|\.pid\b/,
      );
    }
  });
  // BUG-000012-uKKrzikI, Medium (roadmap Items 16 and 17, RM-000017-sJpO9KMY,
  // RM-000018-sJpO9KMY): cttc's tunnel bound the remote port, 8765, which the
  // local gateway already used. A forward listens on a port the OS picks, so
  // it never collides with the local Sump's: both answer side by side.
  it("cttc BUG-000012: Switching to a known remote gateway collides with the local gateway's port", async () => {
    const key = generateKeyPairSync("ed25519").privateKey;
    const host = await sshHost(key);
    const local = await answeringSump();
    const remote = await answeringSump();
    const localPort = Number(new URL(local.sump.baseUrl).port);
    const forwards = new Forwards({ baseDelayMs: 50, logger: quietLog });
    try {
      const forward = forwards.ensure({
        id: "remote",
        sumpPort: Number(new URL(remote.sump.baseUrl).port),
        ssh: { host: "127.0.0.1", port: host.port, username: "ops", key },
      });
      expect(await forward.waitUp(5_000)).toBe(true);
      const forwardPort = Number(new URL(forward.url as string).port);
      expect(forwardPort).not.toBe(localPort);
      expect(forwardPort).not.toBe(8765);
      const both = await Promise.all([
        handleSumpRequest({ sump: "local", method: "GET", path: "/l" }, () => local.sump),
        handleSumpRequest({ sump: "remote", method: "GET", path: "/r" }, () => ({
          name: "remote",
          baseUrl: forward.url as string,
        })),
      ]);
      expect(both).toEqual([
        { ok: true, value: { path: "/l", redis: true } },
        { ok: true, value: { path: "/r", redis: true } },
      ]);
    } finally {
      forwards.stopAll();
      host.close();
      await local.close();
      await remote.close();
    }
  });
});
