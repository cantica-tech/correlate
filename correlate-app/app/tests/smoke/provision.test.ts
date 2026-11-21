/**
 * Provisioning a real local Sump with Docker (REQ-000014-sJpO9KMY
 * Requirement 3), run with `SUMP_SMOKE=1` (`task app:smoke`).
 *
 * It uses the image `task server:up` builds (`correlate-sump:dev`), its own
 * compose project and port, a throwaway vault and catalog, and removes its
 * containers and volume at the end, so a real local Sump is never touched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Catalog } from "../../main/src/catalog/catalog.js";
import { Lifecycle } from "../../main/src/catalog/lifecycle.js";
import { ActiveSumps } from "../../main/src/catalog/windows.js";
import { provisionLocal } from "../../main/src/provision/local.js";
import { runCommand } from "../../main/src/provision/runner.js";
import { handleSumpRequest } from "../../main/src/sump/ipc.js";
import { SessionTokens } from "../../main/src/sump/tokens.js";
import { Vault } from "../../main/src/vault/vault.js";

const PROJECT = "correlate-sump-smoke";
const PORT = 8799;
const dir = mkdtempSync(path.join(tmpdir(), "provision-smoke-"));
const compose = path.join(dir, "sumps", "local", "docker-compose.yml");

afterAll(async () => {
  await runCommand("docker", ["compose", "-f", compose, "-p", PROJECT, "down", "-v"], {
    timeoutMs: 120_000,
  });
  rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.env.SUMP_SMOKE === "1")("provisioning a real local Sump", () => {
  it("starts it with Docker, becomes its owner, logs in and records it", {
    timeout: 240_000,
  }, async () => {
    const catalog = Catalog.open(path.join(dir, "catalog.db"));
    const vault = new Vault(path.join(dir, "vault"), undefined, {
      scrypt: { N: 2 ** 10, r: 8, p: 1 },
      logger: { info: () => {}, warn: () => {} },
    });
    vault.create("a passphrase", "a passphrase");
    const lifecycle = new Lifecycle(catalog, undefined, { info: () => {} });
    const tokens = new SessionTokens();
    const active = new ActiveSumps(catalog);
    active.open(1);
    const result = await provisionLocal(
      {
        run: runCommand,
        lifecycle,
        tokens,
        vault,
        env: { CORRELATE_USER: "smoke", CORRELATE_SUMP_IMAGE: "correlate-sump:dev" },
        appVersion: "0.1.0",
        catalog,
        active,
        localDir: path.join(dir, "sumps", "local"),
        localProject: PROJECT,
      },
      { sumpPort: PORT, windowId: 1, switchTo: true },
    );
    expect(result, JSON.stringify(result)).toEqual({ ok: true, id: "local", switched: true });
    expect(lifecycle.get("local")?.state).toBe("active");
    expect(catalog.get("local")).toMatchObject({ sumpPort: PORT, user: "smoke" });
    const sump = { name: "local", baseUrl: `http://127.0.0.1:${PORT}`, token: tokens.get("local") };
    const users = await handleSumpRequest(
      { sump: "local", method: "GET", path: "/users" },
      () => sump,
    );
    expect(users).toMatchObject({ ok: true, value: { owner: "smoke" } });
    catalog.close();
  });
});
