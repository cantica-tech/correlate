/**
 * Regression corpus of cttc's bugs: key vault and secrets (VAULT).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ownerOnlyProblems, writeSecretFile } from "../../../main/src/vault/secure.js";
import { Vault } from "../../../main/src/vault/vault.js";

const quiet = { info: () => {}, warn: () => {} };
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cttc-vault-"));
  dirs.push(dir);
  return dir;
}

describe("br-VAULT-000004-sJpO9KMY", () => {
  // BUG-000009-uKKrzikI, Critical (roadmap Item 10, RM-000011-sJpO9KMY): a
  // second vault setup wrote a new salt and verifier, and every stored key
  // became undecryptable. A second create is now refused and the keys open.
  it("cttc BUG-000009: vault-setup can re-key an already initialized vault", () => {
    const dir = path.join(folder(), "vault");
    const key = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    const first = new Vault(dir, undefined, { scrypt: FAST, logger: quiet });
    first.create("first passphrase", "first passphrase");
    first.put("sump", key);
    const second = new Vault(dir, undefined, { scrypt: FAST, logger: quiet });
    expect(() => second.create("other passphrase", "other passphrase")).toThrow(
      expect.objectContaining({ code: "exists" }),
    );
    second.unlock("first passphrase");
    expect(second.get("sump")).toBe(key);
  });
});

describe("br-VAULT-000006-sJpO9KMY", () => {
  // BUG-000010-uKKrzikI, Critical (roadmap Item 10, RM-000011-sJpO9KMY): the
  // token file was written with default permissions. Every secret file is now
  // written by writeSecretFile, owner-only on this system (icacls on Windows).
  it("cttc BUG-000010: API token file is written with default permissions", () => {
    const file = path.join(folder(), "session-tokens.json");
    writeSecretFile(file, JSON.stringify({ local: "token" }));
    expect(ownerOnlyProblems(file)).toEqual([]);
  });
});
