import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Lifecycle } from "../../catalog/lifecycle.js";
import { request } from "../client.js";
import { Forwards, type ForwardTarget, SumpForward } from "../forward.js";
import { serve, type TestServer } from "./servers.js";
import { sshHost as startHost } from "./sshhost.js";

// br-SUMP-000008-sJpO9KMY (REQ-000016-sJpO9KMY Requirement 1): the SSH forward,
// against an SSH server in this process that forwards to a fake Sump.

const quiet = { info: () => {}, warn: () => {} };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const userKey = generateKeyPairSync("ed25519").privateKey;

async function sshHost(allowed: KeyObject = userKey) {
  const host = await startHost(allowed);
  cleanups.push(() => host.close());
  return host;
}

async function fakeSump(): Promise<TestServer> {
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, redis: true }));
  });
  cleanups.push(() => s.close());
  return s;
}

function target(
  sshPort: number,
  sumpPort: number,
  key = userKey,
  knownHostKey?: string,
): ForwardTarget {
  return {
    id: "remote-1",
    sumpPort,
    ssh: { host: "127.0.0.1", port: sshPort, username: "ops", key, knownHostKey },
  };
}

const fast = { baseDelayMs: 50, maxDelayMs: 400, resetAfterMs: 60_000, logger: quiet };

describe("br-SUMP-000008-sJpO9KMY: the SSH forward", () => {
  it("is up only once /health answers through it, on a port the OS picked", async () => {
    const sump = await fakeSump();
    const sumpPort = Number(new URL(sump.sump.baseUrl).port);
    const host = await sshHost();
    const lifecycle = new Lifecycle(undefined, undefined, { info: () => {} });
    const forward = new SumpForward(target(host.port, sumpPort), { ...fast, lifecycle });
    cleanups.push(() => forward.stop());
    expect(forward.up).toBe(false);
    forward.start();
    expect(await forward.waitUp(5_000)).toBe(true);
    const port = Number(new URL(forward.url as string).port);
    expect(port).not.toBe(sumpPort);
    expect(port).not.toBe(8765);
    expect(host.forwarded).toContain(sumpPort);
    const answer = await request(
      { name: "remote-1", baseUrl: forward.url as string },
      "GET",
      "/records",
    );
    expect(answer).toEqual({ path: "/records", redis: true });
    expect(lifecycle.get("remote-1")?.state).toBe("active");
  });

  it("reports a drop, moves the Sump to unreachable, and reconnects", async () => {
    const sump = await fakeSump();
    const host = await sshHost();
    const lifecycle = new Lifecycle(undefined, undefined, { info: () => {} });
    const states: string[] = [];
    lifecycle.subscribe((r) => states.push(r.state));
    const forward = new SumpForward(target(host.port, Number(new URL(sump.sump.baseUrl).port)), {
      ...fast,
      lifecycle,
    });
    cleanups.push(() => forward.stop());
    forward.start();
    expect(await forward.waitUp(5_000)).toBe(true);
    host.dropAll();
    await new Promise((r) => setTimeout(r, 30));
    expect(forward.up).toBe(false);
    expect(lifecycle.get("remote-1")?.state).toBe("unreachable");
    expect(await forward.waitUp(5_000)).toBe(true);
    expect(states).toEqual(["unreachable", "active", "unreachable", "active"]);
  });

  it("is never up when the host refuses the key, and keeps trying until stopped", async () => {
    const sump = await fakeSump();
    const host = await sshHost(generateKeyPairSync("ed25519").privateKey);
    const forward = new SumpForward(
      target(host.port, Number(new URL(sump.sump.baseUrl).port)),
      fast,
    );
    forward.start();
    expect(await forward.waitUp(600)).toBe(false);
    expect(forward.lastError).toMatch(/authentication/i);
    forward.stop();
    expect(await forward.waitUp(200)).toBe(false);
  });

  it("refuses a host whose key is not the one pinned", async () => {
    const sump = await fakeSump();
    const host = await sshHost();
    const forward = new SumpForward(
      target(host.port, Number(new URL(sump.sump.baseUrl).port), userKey, "SHA256:pinned"),
      fast,
    );
    cleanups.push(() => forward.stop());
    forward.start();
    expect(await forward.waitUp(600)).toBe(false);
    expect(forward.lastError).toMatch(/host key of 127.0.0.1 changed/);
  });

  it("keeps one forward per Sump and stops them all", async () => {
    const sump = await fakeSump();
    const host = await sshHost();
    const forwards = new Forwards(fast);
    cleanups.push(() => forwards.stopAll());
    const t = target(host.port, Number(new URL(sump.sump.baseUrl).port));
    const a = forwards.ensure(t);
    expect(forwards.ensure(t)).toBe(a);
    expect(await a.waitUp(5_000)).toBe(true);
    expect(forwards.urlOf("remote-1")).toBe(a.url);
    forwards.stopAll();
    expect(forwards.urlOf("remote-1")).toBeUndefined();
  });
});

describe("br-SUMP-000008-sJpO9KMY: an SSH error after the handshake", () => {
  it("is logged, never thrown, while up and after the forward stops", async () => {
    const sump = await fakeSump();
    const host = await sshHost();
    const warnings: string[] = [];
    const forward = new SumpForward(target(host.port, Number(new URL(sump.sump.baseUrl).port)), {
      ...fast,
      logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
    });
    cleanups.push(() => forward.stop());
    forward.start();
    expect(await forward.waitUp(5_000)).toBe(true);
    const client = (forward as unknown as { client: import("ssh2").Client }).client;
    // ssh2 emits a bad packet as an error, possibly more than once.
    expect(() => {
      client.emit("error", new Error("Bad packet length"));
      client.emit("error", new Error("Bad packet length"));
    }).not.toThrow();
    expect(warnings.filter((w) => w.includes("Bad packet length"))).toHaveLength(2);
    forward.stop();
    expect(() => client.emit("error", new Error("Bad packet length"))).not.toThrow();
  });
});

describe("cttc BUG-000008 territory: the transport starts no process", () => {
  it("has no subprocess and no PID in it", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ["../forward.ts", "../../provision/ssh.ts"]) {
      const source = readFileSync(path.join(here, file), "utf8");
      expect(source).not.toMatch(
        /child_process|\bspawn\(|\bexec(File)?Sync\(|process\.kill|\.pid\b/,
      );
    }
  });
});
