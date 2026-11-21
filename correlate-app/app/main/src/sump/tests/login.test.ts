import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { LOGIN_NAMESPACE } from "../../identity/sshkey.js";
import { handleSumpRequest } from "../ipc.js";
import { login } from "../login.js";
import { SessionTokens } from "../tokens.js";
import { serve, type TestServer } from "./servers.js";

// br-CONN-000007-sJpO9KMY, br-CONN-000004-sJpO9KMY (REQ-000011-sJpO9KMY
// Requirement 4): the app logs in, and logs in again when a token is refused.

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A fake Sump: issues `t<n>` tokens at login and accepts only the latest. */
async function fakeSump() {
  const seen: { path: string; body: Record<string, string>; auth?: string }[] = [];
  let issued = 0;
  server = await serve((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ path: req.url ?? "", body, auth: req.headers.authorization });
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/session/challenge") {
        return json(200, { challenge: "c-1", namespace: LOGIN_NAMESPACE, expires_in: 60 });
      }
      if (req.url === "/session/login") {
        issued += 1;
        return json(200, { token: `t${issued}`, user: body.user, owner: true });
      }
      if (req.headers.authorization === `Bearer t${issued}` && issued > 0) {
        return json(200, { ok: true });
      }
      return json(401, { detail: "a valid session token is needed" });
    });
  });
  return seen;
}

const key = generateKeyPairSync("ed25519").privateKey;

describe("br-CONN-000007-sJpO9KMY: login", () => {
  it("signs the challenge and keeps the token in memory", async () => {
    const seen = await fakeSump();
    const tokens = new SessionTokens();
    const result = await login((server as TestServer).sump, "alice", key, tokens);
    expect(result).toEqual({ user: "alice", owner: true });
    expect(tokens.get("test")).toBe("t1");
    const sent = seen.find((s) => s.path === "/session/login");
    expect(sent?.body.user).toBe("alice");
    expect(sent?.body.challenge).toBe("c-1");
    expect(sent?.body.signature).toMatch(/^-----BEGIN SSH SIGNATURE-----\n/);
  });
});

describe("br-CONN-000004-sJpO9KMY: a refused token is renewed once", () => {
  function setup() {
    const tokens = new SessionTokens();
    const sump = (server as TestServer).sump;
    const resolve = (name: string) => {
      if (name !== "test") return undefined;
      const token = tokens.get(name);
      return token ? { ...sump, token } : { ...sump };
    };
    return { tokens, resolve, sump };
  }

  it("logs in and retries the call", async () => {
    await fakeSump();
    const { tokens, resolve, sump } = setup();
    tokens.set("test", "stale");
    let logins = 0;
    const reply = await handleSumpRequest(
      { sump: "test", method: "GET", path: "/plugins" },
      resolve,
      tokens,
      async () => {
        logins += 1;
        await login(sump, "alice", key, tokens);
      },
    );
    expect(reply).toEqual({ ok: true, value: { ok: true } });
    expect(logins).toBe(1);
    expect(tokens.get("test")).toBe("t1");
  });

  it("reports login-needed when the login fails", async () => {
    await fakeSump();
    const { tokens, resolve } = setup();
    const reply = await handleSumpRequest(
      { sump: "test", method: "GET", path: "/plugins" },
      resolve,
      tokens,
      async () => {
        throw new Error("the key vault is locked");
      },
    );
    expect(reply).toEqual({
      ok: false,
      error: { kind: "login-needed", message: "login failed: the key vault is locked" },
    });
  });

  it("does not loop when the new token is refused too", async () => {
    await fakeSump();
    const { tokens, resolve } = setup();
    let logins = 0;
    const reply = await handleSumpRequest(
      { sump: "test", method: "GET", path: "/plugins" },
      resolve,
      tokens,
      async () => {
        logins += 1;
        tokens.set("test", "also-wrong");
      },
    );
    expect(reply).toMatchObject({ ok: false, error: { kind: "login-needed" } });
    expect(logins).toBe(1);
    expect(tokens.get("test")).toBeUndefined();
  });
});

describe("br-SUMP-000001-sJpO9KMY: a successful login records the Sump", () => {
  it("records the local Sump with the user it logged in as", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { Catalog } = await import("../../catalog/catalog.js");
    const { Vault } = await import("../../vault/vault.js");
    const { configuredSumps, reloginWith } = await import("../../index.js");
    await fakeSump();
    const dir = mkdtempSync(path.join(tmpdir(), "record-test-"));
    try {
      const catalog = Catalog.open(path.join(dir, "catalog.db"));
      const vault = new Vault(path.join(dir, "vault"), undefined, {
        scrypt: { N: 2 ** 10, r: 8, p: 1 },
        logger: { info: () => {}, warn: () => {} },
      });
      vault.create("a passphrase", "a passphrase");
      const env = {
        CORRELATE_SUMP_URL: (server as TestServer).sump.baseUrl,
        CORRELATE_USER: "alice",
      };
      const tokens = new SessionTokens();
      const resolve = configuredSumps(env, tokens, catalog);
      expect(catalog.list()).toEqual([]);
      await reloginWith(vault, resolve, tokens, env, catalog)("local");
      const [entry] = catalog.list();
      expect(entry).toMatchObject({ id: "local", kind: "local", user: "alice" });
      expect(entry?.sumpPort).toBe(Number(new URL((server as TestServer).sump.baseUrl).port));
      catalog.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
