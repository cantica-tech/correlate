import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openVault } from "../index.js";

// REQ-000008-sJpO9KMY Requirement 5: the app opens its vault in user data.

const touched: string[] = [];
const noSafeStorage = {
  isEncryptionAvailable: () => {
    touched.push("isEncryptionAvailable");
    return false;
  },
  encryptString: () => Buffer.alloc(0),
  decryptString: () => "",
};
let userData: string;

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
  touched.length = 0;
});

describe("br-VAULT-000001-sJpO9KMY: the app's vault", () => {
  it("opens in user data without touching safe storage or the disk", () => {
    userData = mkdtempSync(path.join(tmpdir(), "user-data-"));
    const vault = openVault(userData, noSafeStorage);
    expect(vault?.dir).toBe(path.join(userData, "vault"));
    expect(vault?.state).toBe("none");
    expect(touched).toEqual([]);
    expect(existsSync(path.join(userData, "vault"))).toBe(false);
  });

  it("reports a corrupt vault and leaves the app without one", () => {
    userData = mkdtempSync(path.join(tmpdir(), "user-data-"));
    mkdirSync(path.join(userData, "vault"));
    writeFileSync(path.join(userData, "vault", "vault.json"), "garbage");
    const warnings: string[] = [];
    const vault = openVault(userData, noSafeStorage, {
      info: () => {},
      warn: (m) => warnings.push(m),
    });
    expect(vault).toBeUndefined();
    expect(warnings[0]).toContain("unreadable");
  });
});
