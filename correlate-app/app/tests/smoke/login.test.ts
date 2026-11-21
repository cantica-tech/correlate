/**
 * The app's SSH-key login against the real Sump container
 * (br-CONN-000007-sJpO9KMY, br-CONN-000004-sJpO9KMY, REQ-000011-sJpO9KMY).
 *
 * Needs Docker and the stack from `task server:up`, so it runs only with
 * `SUMP_SMOKE=1` (`task app:smoke`). The app's identity key, made in a
 * throwaway vault, is installed as the Sump's owner with the owner command
 * run inside the container, as provisioning will; then the app logs in on its
 * own when the Sump first refuses it, signing with its own SSHSIG code, which
 * the Sump checks with its Python verifier.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { identityPublicKey } from "../../main/src/identity/identity.js";
import { configuredSumps, reloginWith } from "../../main/src/index.js";
import { request } from "../../main/src/sump/client.js";
import { handleSumpRequest } from "../../main/src/sump/ipc.js";
import { SessionTokens } from "../../main/src/sump/tokens.js";
import { Vault } from "../../main/src/vault/vault.js";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../server");
const dir = mkdtempSync(path.join(tmpdir(), "app-smoke-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Wait up to 60 s for the Sump to answer `/health` with Redis up. */
async function healthy(sump: { name: string; baseUrl: string }): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const health = await request<{ redis: boolean }>(sump, "GET", "/health", {
        timeoutMs: 2_000,
        logger: { warn: () => {} },
      });
      if (health.redis) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error("the Sump did not become healthy in time");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

describe.runIf(process.env.SUMP_SMOKE === "1")("br-CONN-000007-sJpO9KMY: the app logs in", () => {
  it("logs in with its identity key and reaches owner routes", { timeout: 90_000 }, async () => {
    const vault = new Vault(path.join(dir, "vault"), undefined, {
      scrypt: { N: 2 ** 10, r: 8, p: 1 },
      logger: { info: () => {}, warn: () => {} },
    });
    vault.create("a passphrase", "a passphrase");
    const env = { CORRELATE_USER: "app-smoke", CORRELATE_SUMP_URL: process.env.SUMP_URL };
    execFileSync(
      "docker",
      ["compose", "exec", "-T", "sump", "python", "-m", "correlate_sump.users"].concat([
        "set-owner",
        "--user",
        "app-smoke",
        "--replace",
      ]),
      { cwd: SERVER, input: identityPublicKey(vault) },
    );
    const tokens = new SessionTokens();
    const sumps = configuredSumps(env, tokens);
    await healthy(sumps("local") as { name: string; baseUrl: string });
    const relogin = reloginWith(vault, sumps, tokens, env);
    const plugins = await handleSumpRequest(
      { sump: "local", method: "GET", path: "/plugins" },
      sumps,
      tokens,
      relogin,
    );
    expect(plugins, JSON.stringify(plugins)).toMatchObject({ ok: true });
    expect(tokens.get("local")).toBeTruthy();
    const users = await handleSumpRequest(
      { sump: "local", method: "GET", path: "/users" },
      sumps,
      tokens,
      relogin,
    );
    expect(users).toMatchObject({ ok: true, value: { owner: "app-smoke" } });
  });
});
