import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "../../vault/vault.js";
import {
  ensureIdentity,
  IDENTITY_ID,
  identityPublicKey,
  importIdentity,
  userName,
} from "../identity.js";
import {
  fingerprint,
  LOGIN_NAMESPACE,
  privateKeyFrom,
  publicKeyLine,
  SshKeyError,
  signSshsig,
} from "../sshkey.js";

// br-CONN-000007-sJpO9KMY (REQ-000011-sJpO9KMY Requirements 1 and 4): the
// user's SSH identity and its SSHSIG signatures.

const KEYGEN = spawnSync("ssh-keygen", ["-Y", "sign"], { encoding: "utf8" });
const HAS_KEYGEN = !KEYGEN.error && /Too few arguments|usage/i.test(KEYGEN.stderr ?? "");
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const quiet = { info: () => {}, warn: () => {} };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "identity-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function vault(): Vault {
  const v = new Vault(path.join(dir, "vault"), undefined, { scrypt: FAST, logger: quiet });
  v.create("a passphrase", "a passphrase");
  return v;
}

/** A PEM private key of each accepted kind, made by Node. */
const KINDS: Record<string, () => string> = {
  ed25519: () => pem(generateKeyPairSync("ed25519").privateKey, "pkcs8"),
  "ecdsa p256": () => pem(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey, "sec1"),
  "ecdsa p384": () => pem(generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey, "pkcs8"),
  "ecdsa p521": () => pem(generateKeyPairSync("ec", { namedCurve: "P-521" }).privateKey, "pkcs8"),
  "rsa 3072": () => pem(generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey, "pkcs1"),
};

function pem(key: import("node:crypto").KeyObject, type: "pkcs8" | "pkcs1" | "sec1"): string {
  return key.export({ type, format: "pem" }) as string;
}

/** Check `signature` of `message` with `ssh-keygen -Y verify`, for `line`. */
function opensshVerifies(line: string, message: string, signature: string): boolean {
  writeFileSync(path.join(dir, "allowed"), `alice ${line}\n`);
  writeFileSync(path.join(dir, "msg.sig"), signature);
  const result = spawnSync(
    "ssh-keygen",
    ["-Y", "verify", "-f", path.join(dir, "allowed"), "-I", "alice"].concat([
      "-n",
      LOGIN_NAMESPACE,
      "-s",
      path.join(dir, "msg.sig"),
    ]),
    { input: message },
  );
  return result.status === 0;
}

describe("br-CONN-000007-sJpO9KMY: keys and signatures", () => {
  it.each(Object.keys(KINDS))("reads a %s key and signs in SSHSIG format", (kind) => {
    const key = privateKeyFrom((KINDS[kind] as () => string)());
    const signature = signSshsig(key, "challenge", LOGIN_NAMESPACE);
    expect(signature.startsWith("-----BEGIN SSH SIGNATURE-----\n")).toBe(true);
    expect(fingerprint(key)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    if (HAS_KEYGEN) {
      expect(opensshVerifies(publicKeyLine(key), "challenge", signature)).toBe(true);
      expect(opensshVerifies(publicKeyLine(key), "other", signature)).toBe(false);
    }
  });

  it.each([
    [
      "RSA 2048",
      () => pem(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey, "pkcs8"),
      /3072/,
    ],
    [
      "secp256k1",
      () => pem(generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey, "pkcs8"),
      /curve/,
    ],
    ["Ed448", () => pem(generateKeyPairSync("ed448").privateKey, "pkcs8"), /ed448/],
    [
      "junk",
      () => "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
      /cannot be read/,
    ],
  ])("refuses %s", (_name, make, why) => {
    expect(() => privateKeyFrom(make())).toThrow(SshKeyError);
    expect(() => privateKeyFrom(make())).toThrow(why);
  });

  it.runIf(HAS_KEYGEN).each([
    ["ed25519", []],
    ["ecdsa", ["-b", "384"]],
    ["rsa", ["-b", "3072"]],
  ])("reads OpenSSH %s keys as ssh-keygen does", (type, extra) => {
    const file = path.join(dir, `id_${type}`);
    execFileSync("ssh-keygen", ["-q", "-t", type, ...extra, "-N", "", "-C", "", "-f", file]);
    const key = privateKeyFrom(readFileSync(file, "utf8"));
    expect(publicKeyLine(key)).toBe(readFileSync(`${file}.pub`, "utf8").trim());
    const signature = signSshsig(key, "challenge", LOGIN_NAMESPACE);
    expect(opensshVerifies(publicKeyLine(key), "challenge", signature)).toBe(true);
  });

  it.runIf(HAS_KEYGEN)("refuses an OpenSSH key protected by a passphrase", () => {
    const file = path.join(dir, "id_locked");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "secret phrase", "-f", file]);
    expect(() => privateKeyFrom(readFileSync(file, "utf8"))).toThrow(/passphrase/);
  });
});

describe("br-CONN-000007-sJpO9KMY: the identity in the vault", () => {
  it("generates an Ed25519 key once, then keeps it", () => {
    const v = vault();
    expect(v.has(IDENTITY_ID)).toBe(false);
    const first = identityPublicKey(v);
    expect(first).toMatch(/^ssh-ed25519 AAAA\S+ correlate-app$/);
    expect(identityPublicKey(v)).toBe(first);
    expect(fingerprint(ensureIdentity(v))).toBe(fingerprint(ensureIdentity(v)));
  });

  it("imports an existing key, and refuses one outside the policy", () => {
    const v = vault();
    const key = (KINDS["ecdsa p256"] as () => string)();
    importIdentity(v, key);
    expect(identityPublicKey(v)).toBe(`${publicKeyLine(privateKeyFrom(key))} correlate-app`);
    const weak = pem(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey, "pkcs8");
    expect(() => importIdentity(v, weak)).toThrow(/3072/);
    expect(identityPublicKey(v)).toBe(`${publicKeyLine(privateKeyFrom(key))} correlate-app`);
  });

  it("names the user from CORRELATE_USER or the system, as a Sump accepts", () => {
    expect(userName({ CORRELATE_USER: "Olivier Steck" })).toBe("olivier-steck");
    expect(userName({ CORRELATE_USER: "x".repeat(80) })).toHaveLength(64);
    expect(userName({})).toMatch(/^[a-z0-9._-]{1,64}$/);
  });
});
