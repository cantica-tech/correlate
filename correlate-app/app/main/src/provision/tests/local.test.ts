import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "../../catalog/catalog.js";
import { Lifecycle } from "../../catalog/lifecycle.js";
import { ActiveSumps } from "../../catalog/windows.js";
import { LOGIN_NAMESPACE } from "../../identity/sshkey.js";
import { serve, type TestServer } from "../../sump/tests/servers.js";
import { SessionTokens } from "../../sump/tokens.js";
import { Vault } from "../../vault/vault.js";
import { composeFile, LOCAL_PROJECT, type ProvisionContext, provisionLocal } from "../local.js";
import type { CommandResult, Runner } from "../runner.js";

// REQ-000014-sJpO9KMY Requirements 3 and 5 (br-SUMP-000007-sJpO9KMY,
// br-SUMP-000001-sJpO9KMY, br-SUMP-000011-sJpO9KMY): provisioning a Sump on
// this machine, and failing cleanly.

const quiet = { info: () => {}, warn: () => {} };
const ok: CommandResult = { code: 0, stdout: "29\n", stderr: "", timedOut: false };
let dir: string;
let server: TestServer | undefined;
let catalog: Catalog;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "provision-test-"));
  catalog = Catalog.open(path.join(dir, "catalog.db"));
});
afterEach(async () => {
  catalog.close();
  await server?.close();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** A fake Sump answering /health, the challenge and the login. */
async function fakeSump(loginStatus = 200) {
  server = await serve((req, res) => {
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
        const user = JSON.parse(body).user;
        return json(
          loginStatus,
          loginStatus === 200 ? { token: "t", user, owner: true } : { detail: "login refused" },
        );
      }
      return json(404, {});
    });
  });
  return Number(new URL(server.sump.baseUrl).port);
}

function context(run: Runner): ProvisionContext & { commands: string[][] } {
  const vault = new Vault(path.join(dir, "vault"), undefined, {
    scrypt: { N: 2 ** 10, r: 8, p: 1 },
    logger: quiet,
  });
  vault.create("a passphrase", "a passphrase");
  const commands: string[][] = [];
  const lifecycle = new Lifecycle(catalog, undefined, { info: () => {} });
  return {
    commands,
    run: async (command, args, options) => {
      commands.push([command, ...args]);
      return run(command, args, options);
    },
    lifecycle,
    tokens: new SessionTokens(),
    vault,
    env: { CORRELATE_USER: "olivier", CORRELATE_SUMP_IMAGE: "correlate-sump:dev" },
    appVersion: "0.1.0",
    catalog,
    active: new ActiveSumps(catalog),
    localDir: path.join(dir, "sumps", "local"),
    healthTimeoutMs: 3_000,
    logger: quiet,
  };
}

describe("br-SUMP-000001-sJpO9KMY: provisioning a local Sump", () => {
  it("starts it, makes the user owner, logs in, records it and moves the window", async () => {
    const port = await fakeSump();
    const ctx = context(async () => ok);
    ctx.active?.open(1);
    ctx.active?.open(2);
    const result = await provisionLocal(ctx, { sumpPort: port, windowId: 1, switchTo: true });
    expect(result).toEqual({ ok: true, id: "local", switched: true });
    const file = path.join(dir, "sumps", "local", "docker-compose.yml");
    expect(ctx.commands.slice(1, 2)).toEqual([
      ["docker", "compose", "-f", file, "-p", LOCAL_PROJECT, "up", "-d"],
    ]);
    expect(ctx.commands[2]?.slice(6)).toEqual([
      "exec",
      "-T",
      "sump",
      "python",
      "-m",
      "correlate_sump.users",
      "set-owner",
      "--user",
      "olivier",
    ]);
    expect(readFileSync(file, "utf8")).toBe(composeFile("correlate-sump:dev", port));
    expect(catalog.get("local")).toMatchObject({ kind: "local", sumpPort: port, user: "olivier" });
    expect(ctx.lifecycle.get("local")?.state).toBe("active");
    expect(ctx.tokens.get("local")).toBe("t");
    expect([ctx.active?.get(1), ctx.active?.get(2)]).toEqual(["local", "local"]);
    if (process.platform !== "win32") {
      expect(statSync(path.join(dir, "sumps")).mode & 0o777).toBe(0o700);
    }
  });

  it("publishes every port on loopback only", () => {
    const text = composeFile("img", 8765);
    const ports = text.split("\n").filter((l) => l.trim().startsWith('- "'));
    expect(ports.length).toBe(2);
    expect(ports.every((l) => l.includes('"127.0.0.1:'))).toBe(true);
  });

  it("fails clearly without Docker, running nothing else", async () => {
    const ctx = context(async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }));
    const result = await provisionLocal(ctx);
    expect(result).toEqual({
      ok: false,
      step: "check Docker",
      message: "Docker is not available on this machine",
    });
    expect(ctx.commands).toHaveLength(1);
    expect(ctx.lifecycle.get("local")).toBeUndefined();
  });
});

describe("br-SUMP-000007-sJpO9KMY: a failed provisioning cleans up", () => {
  it("stops the Sump, retires it, records nothing and moves no window", async () => {
    const port = await fakeSump(401);
    const ctx = context(async () => ok);
    ctx.active?.open(1);
    const result = await provisionLocal(ctx, { sumpPort: port, windowId: 1, switchTo: true });
    expect(result).toMatchObject({ ok: false, step: "log in" });
    expect(ctx.commands.at(-1)?.slice(-1)).toEqual(["down"]);
    expect(catalog.list({ retired: true })).toEqual([]);
    expect(ctx.lifecycle.get("local")?.state).toBe("retired");
    expect(ctx.tokens.get("local")).toBeUndefined();
    expect(ctx.active?.get(1)).toBe("local");
    // Never connected: it may be provisioned again.
    const again = await fakeSump();
    const retry = await provisionLocal(ctx, { sumpPort: again });
    expect(retry).toMatchObject({ ok: true, switched: false });
  });

  it("names the step that failed", async () => {
    const ctx = context(async (_command, args) =>
      args.includes("up")
        ? { code: 1, stdout: "", stderr: "pull access denied for correlate-sump", timedOut: false }
        : ok,
    );
    const result = await provisionLocal(ctx);
    expect(result).toEqual({
      ok: false,
      step: "start the Sump",
      message: "pull access denied for correlate-sump",
    });
  });

  it("refuses a second local Sump", async () => {
    catalog.recordConnect({ kind: "local", sumpPort: 8765 });
    const ctx = context(async () => ok);
    expect(await provisionLocal(ctx)).toMatchObject({ ok: false, step: "check" });
    expect(ctx.commands).toEqual([]);
  });
});
