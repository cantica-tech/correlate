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
import { describe, expect, it } from "vitest";
import { Catalog } from "../../../main/src/catalog/catalog.js";
import { Vault } from "../../../main/src/vault/vault.js";

describe("br-SUMP-000006-sJpO9KMY", () => {
  // BUG-000001-uKKrzikI, Critical: becomes a real test with roadmap Item 18
  // (RM-000019-sJpO9KMY).
  it.todo("cttc BUG-000001: PowerShell command injection via peer gateway host");
});

describe("br-SUMP-000005-sJpO9KMY", () => {
  // BUG-000002-uKKrzikI, Medium: becomes a real test with roadmap Item 18
  // (RM-000019-sJpO9KMY).
  it.todo("cttc BUG-000002: Telnet fallback reports open ports as closed");
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
  // BUG-000004-uKKrzikI, High: becomes a real test with roadmap Item 16
  // (RM-000017-sJpO9KMY).
  it.todo("cttc BUG-000004: Uninstalled gateway's host can never be re-added");
});

describe("br-SUMP-000003-sJpO9KMY", () => {
  // BUG-000005-uKKrzikI, High: becomes a real test with roadmap Item 16, Item 17
  // (RM-000017-sJpO9KMY, RM-000018-sJpO9KMY).
  it.todo("cttc BUG-000005: Failed switch to a remote gateway tears down the current tunnel");
  // BUG-000006-uKKrzikI, Medium: becomes a real test with roadmap Item 15
  // (RM-000016-sJpO9KMY).
  it.todo(
    "cttc BUG-000006: Choosing 'Later' after adding a gateway leaves the window on a dead connection",
  );
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
  // BUG-000008-uKKrzikI, High: becomes a real test with roadmap Item 17
  // (RM-000018-sJpO9KMY).
  it.todo("cttc BUG-000008: Orphan cleanup can kill an unrelated process");
  // BUG-000012-uKKrzikI, Medium: becomes a real test with roadmap Item 16, Item 17
  // (RM-000017-sJpO9KMY, RM-000018-sJpO9KMY).
  it.todo(
    "cttc BUG-000012: Switching to a known remote gateway collides with the local gateway's port",
  );
});
