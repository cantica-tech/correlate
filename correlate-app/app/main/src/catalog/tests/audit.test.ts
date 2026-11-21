import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectSsh } from "../../provision/ssh.js";
import { Forwards } from "../../sump/forward.js";
import { neverAnswers, serve, type TestServer } from "../../sump/tests/servers.js";
import { type SshHost, sshHost } from "../../sump/tests/sshhost.js";
import { Vault } from "../../vault/vault.js";
import { auditSumps, interpret } from "../audit.js";
import { Catalog } from "../catalog.js";
import { Lifecycle } from "../lifecycle.js";
import { ActiveSumps } from "../windows.js";

// br-SUMP-000005-sJpO9KMY (REQ-000017-sJpO9KMY Requirements 1 and 2): the
// audit and its truth table.

const quiet = { info: () => {}, warn: () => {} };
let dir: string;
let catalog: Catalog;
const cleanups: (() => unknown)[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "audit-test-"));
  catalog = Catalog.open(path.join(dir, "catalog.db"));
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

async function answering(): Promise<TestServer> {
  const s = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  cleanups.push(() => s.close());
  return s;
}

/** A port nothing listens on: bind one, then close it. */
async function closedPort(): Promise<number> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const portOf = (s: TestServer) => Number(new URL(s.sump.baseUrl).port);

describe("br-SUMP-000005-sJpO9KMY: the truth table", () => {
  it.each([
    [{ healthOk: true, portRefused: false }, undefined, "existing"],
    [{ healthOk: true, portRefused: false }, "absent", "existing"],
    [{ healthOk: false, portRefused: true }, "existing", "absent"],
    [{ healthOk: false, portRefused: true }, "absent", "absent"],
    [{ healthOk: false, portRefused: true }, "unknown", "unknown"],
    [{ healthOk: false, portRefused: true }, undefined, "unknown"],
    [{ healthOk: false, portRefused: false }, "existing", "unknown"],
    [{ healthOk: false, portRefused: false }, undefined, "unknown"],
  ] as const)("%j after %s is %s", (probe, previous, expected) => {
    expect(interpret(probe, previous)).toBe(expected);
  });
});

describe("br-SUMP-000005-sJpO9KMY: probing local Sumps", () => {
  it("finds an answering Sump existing, a closed port absent once confirmed, a silent one unknown", async () => {
    const up = await answering();
    const silent = await serve(neverAnswers);
    cleanups.push(() => silent.close());
    const gone = await closedPort();
    catalog.recordConnect({ kind: "local", sumpPort: portOf(up) });
    const a = catalog.recordConnect({ kind: "remote", sumpPort: 1, sshTarget: "a" });
    const results = await auditSumps({ catalog }, { timeoutMs: 300 });
    expect(results.find((r) => r.id === "local")).toMatchObject({
      existence: "existing",
      lastContactResult: "ok",
    });
    expect(results.find((r) => r.id === a.id)?.existence).toBe("unknown");
    expect(catalog.get("local")?.existence).toBe("existing");

    catalog.recordConnect({ kind: "local", sumpPort: gone });
    expect(
      (await auditSumps({ catalog }, { timeoutMs: 300 })).find((r) => r.id === "local")?.existence,
    ).toBe("absent");
    catalog.recordConnect({ kind: "local", sumpPort: portOf(silent) });
    catalog.amend("local", { existence: "existing" });
    expect(
      (await auditSumps({ catalog }, { timeoutMs: 300 })).find((r) => r.id === "local")?.existence,
    ).toBe("unknown");
  });

  it("never runs more than 4 probes at once, and a hung one does not hold up the rest", async () => {
    let running = 0;
    let most = 0;
    const slow = await serve((_req, res) => {
      running += 1;
      most = Math.max(most, running);
      setTimeout(() => {
        running -= 1;
        res.writeHead(200);
        res.end("{}");
      }, 50);
    });
    cleanups.push(() => slow.close());
    for (let i = 0; i < 9; i += 1) {
      catalog.recordConnect({ kind: "remote", sumpPort: portOf(slow), sshTarget: `h${i}` });
    }
    const forwards = { urlOf: () => slow.sump.baseUrl } as unknown as Forwards;
    const started = Date.now();
    const results = await auditSumps({ catalog, forwards }, { timeoutMs: 2_000 });
    expect(results.every((r) => r.existence === "existing")).toBe(true);
    expect(most).toBeLessThanOrEqual(4);
    expect(most).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("br-SUMP-000005-sJpO9KMY: probing remote Sumps through SSH", () => {
  async function remoteSetup() {
    const vault = new Vault(path.join(dir, "vault"), undefined, {
      scrypt: { N: 2 ** 10, r: 8, p: 1 },
      logger: quiet,
    });
    vault.create("a passphrase", "a passphrase");
    const pem = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    vault.put("identity", pem);
    const { privateKeyFrom } = await import("../../identity/sshkey.js");
    const host: SshHost = await sshHost(privateKeyFrom(pem));
    cleanups.push(() => host.close());
    return { vault, host };
  }

  it("is existing through its forward, and through SSH absent when its port refuses", async () => {
    const { vault, host } = await remoteSetup();
    const up = await answering();
    const gone = await closedPort();
    const lifecycle = new Lifecycle(catalog, undefined, { info: () => {} });
    const forwards = new Forwards({ lifecycle, logger: quiet });
    cleanups.push(() => forwards.stopAll());
    const withForward = catalog.recordConnect({
      kind: "remote",
      sumpPort: portOf(up),
      sshTarget: `ops@127.0.0.1`,
      sshPort: host.port,
    });
    const portGone = catalog.recordConnect({
      kind: "remote",
      sumpPort: gone,
      sshTarget: "ops@localhost",
      sshPort: host.port,
    });
    const { privateKeyFrom } = await import("../../identity/sshkey.js");
    const forward = forwards.ensure({
      id: withForward.id,
      sumpPort: portOf(up),
      ssh: {
        host: "127.0.0.1",
        port: host.port,
        username: "ops",
        key: privateKeyFrom(vault.get("identity")),
      },
    });
    expect(await forward.waitUp(5_000)).toBe(true);
    const results = await auditSumps(
      { catalog, vault, forwards, connect: connectSsh },
      { timeoutMs: 3_000 },
    );
    expect(results.find((r) => r.id === withForward.id)?.existence).toBe("existing");
    // Confirmed before (a connect), its port now refuses on a host that answers: absent.
    expect(results.find((r) => r.id === portGone.id)?.existence).toBe("absent");
  });

  it("is unknown when the host does not answer SSH, even after a confirmation", async () => {
    const { vault } = await remoteSetup();
    const noSsh = await closedPort();
    const e = catalog.recordConnect({
      kind: "remote",
      sumpPort: 8765,
      sshTarget: "127.0.0.1",
      sshPort: noSsh,
    });
    expect(e.existence).toBe("existing");
    const [result] = await auditSumps(
      { catalog, vault, connect: connectSsh },
      { timeoutMs: 2_000 },
    );
    expect(result?.existence).toBe("unknown");
  });

  it("changes nothing but the audit fields: no Sump added, no state, no window", async () => {
    const { vault } = await remoteSetup();
    const a = catalog.recordConnect({
      kind: "remote",
      sumpPort: 1,
      sshTarget: "127.0.0.1",
      sshPort: 1,
    });
    const lifecycle = new Lifecycle(catalog, undefined, { info: () => {} });
    const active = new ActiveSumps(catalog);
    active.open(1);
    active.set(1, a.id);
    const before = { states: lifecycle.states(), entries: catalog.list({ retired: true }).length };
    await auditSumps({ catalog, vault, connect: connectSsh }, { timeoutMs: 1_000 });
    expect(lifecycle.states()).toEqual(before.states);
    expect(catalog.list({ retired: true })).toHaveLength(before.entries);
    expect(active.get(1)).toBe(a.id);
    // Only the audit fields may differ.
    const strip = (e: object | undefined) => {
      const {
        existence: _e,
        lastContactAt: _l,
        lastContactResult: _r,
        ...rest
      } = (e ?? {}) as Record<string, unknown>;
      return rest;
    };
    expect(strip(catalog.get(a.id))).toEqual(strip(a));
  });
});
