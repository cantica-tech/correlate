import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SafeStorageLike, safeStorageUsable } from "../cipher.js";
import { VaultError } from "../errors.js";
import { META_FILE, ORPHAN_KEEP_MS, ORPHANS_DIR, Vault } from "../vault.js";

// br-VAULT-000001-sJpO9KMY, br-VAULT-000004-sJpO9KMY (REQ-000008-sJpO9KMY
// Requirements 2 to 4): keys encrypted at rest, passphrase rules, keys handed
// over in memory or as a file that is always deleted.

const POSIX = process.platform !== "win32";
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const quiet = { info: () => {}, warn: () => {} };
const PASS = "correct horse";

/** A real PEM private key, different each call. */
function newKey(): string {
  return generateKeyPairSync("ed25519").privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
}

/** A stand-in for Electron's safeStorage that scrambles bytes reversibly. */
function fakeSafeStorage(backend?: string, available = true): SafeStorageLike {
  const flip = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
  const storage: SafeStorageLike = {
    isEncryptionAvailable: () => available,
    encryptString: (s) => flip(Buffer.from(s, "utf8")),
    decryptString: (b) => flip(b).toString("utf8"),
  };
  if (backend) storage.getSelectedStorageBackend = () => backend;
  return storage;
}

let dir: string;
beforeEach(() => {
  dir = path.join(mkdtempSync(path.join(tmpdir(), "vault-test-")), "vault");
});
afterEach(() => {
  rmSync(path.dirname(dir), { recursive: true, force: true });
});

const open = (safeStorage?: SafeStorageLike) =>
  new Vault(dir, safeStorage, { scrypt: FAST, logger: quiet });

/** Every byte the vault wrote, as one string. */
function everything(): string {
  return readdirSync(dir)
    .map((f) => readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

describe("br-VAULT-000001-sJpO9KMY: keys encrypted at rest", () => {
  it.each([
    ["safe storage", () => fakeSafeStorage()],
    ["a passphrase", () => undefined],
  ])("round-trips a key with %s, and stores no plaintext", (_how, storage) => {
    const vault = open(storage());
    vault.create(PASS, PASS);
    const key = newKey();
    vault.put("identity", key);
    expect(vault.get("identity")).toBe(key);
    expect(vault.has("identity")).toBe(true);
    const body = key.split("\n")[1] as string;
    expect(everything()).not.toContain(body.slice(0, 20));
    expect(everything()).not.toContain("identity");
  });

  it("treats Linux's basic_text backend as no safe storage", () => {
    expect(safeStorageUsable(fakeSafeStorage("basic_text"))).toBe(false);
    expect(safeStorageUsable(fakeSafeStorage("gnome_libsecret"))).toBe(true);
    expect(safeStorageUsable(fakeSafeStorage(undefined, false))).toBe(false);
    const vault = open(fakeSafeStorage("basic_text"));
    expect(vault.needsPassphrase()).toBe(true);
    vault.create(PASS, PASS);
    expect(vault.mode).toBe("passphrase");
  });

  it("names files by an HMAC under a key of each vault's own", () => {
    const a = open();
    a.create(PASS, PASS);
    a.put("identity", newKey());
    const first = readdirSync(dir).filter((f) => f.endsWith(".key"));
    rmSync(dir, { recursive: true });
    const b = open();
    b.create(PASS, PASS);
    b.put("identity", newKey());
    const second = readdirSync(dir).filter((f) => f.endsWith(".key"));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]).toMatch(/^[A-Za-z0-9_-]{43}\.key$/);
  });

  it.each([
    ["safe storage", () => fakeSafeStorage()],
    ["a passphrase", () => undefined],
  ])("refuses a key file moved over another id's, with %s", (_how, storage) => {
    const vault = open(storage());
    vault.create(PASS, PASS);
    vault.put("a", newKey());
    vault.put("b", newKey());
    const files = readdirSync(dir).filter((f) => f.endsWith(".key"));
    const [fa, fb] = files.map((f) => path.join(dir, f)) as [string, string];
    writeFileSync(fb, readFileSync(fa));
    const victim = vault.has("a") && readFileSync(fa, "utf8") === readFileSync(fb, "utf8");
    expect(victim).toBe(true);
    const outcomes = ["a", "b"].map((id) => {
      try {
        vault.get(id);
        return "ok";
      } catch (error) {
        return (error as VaultError).code;
      }
    });
    expect(outcomes.sort()).toEqual(["ok", "unreadable"]);
  });

  it("refuses a tampered key file", () => {
    const vault = open();
    vault.create(PASS, PASS);
    vault.put("a", newKey());
    const file = path.join(dir, readdirSync(dir).find((f) => f.endsWith(".key")) as string);
    const envelope = JSON.parse(readFileSync(file, "utf8"));
    const data = Buffer.from(envelope.data, "base64");
    data[0] = (data[0] as number) ^ 1;
    envelope.data = data.toString("base64");
    writeFileSync(file, JSON.stringify(envelope));
    expect(() => vault.get("a")).toThrow(expect.objectContaining({ code: "unreadable" }));
  });

  it("leaves no temporary file behind, and writes owner-only", () => {
    const vault = open();
    vault.create(PASS, PASS);
    vault.put("a", newKey());
    vault.put("a", newKey());
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    if (POSIX) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      for (const f of readdirSync(dir)) {
        expect(statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);
      }
    }
  });

  it("refuses a corrupt vault.json and leaves it as is", () => {
    open().create(PASS, PASS);
    writeFileSync(path.join(dir, META_FILE), "{ not json");
    expect(() => open()).toThrow(expect.objectContaining({ code: "unreadable" }));
    expect(readFileSync(path.join(dir, META_FILE), "utf8")).toBe("{ not json");
  });

  it("says so when a safe-storage vault's storage has gone", () => {
    const vault = open(fakeSafeStorage());
    vault.create();
    vault.put("a", newKey());
    expect(() => open(fakeSafeStorage(undefined, false)).get("a")).toThrow(
      expect.objectContaining({ code: "safe-storage-unavailable" }),
    );
  });

  it("removes a key, and says when none is stored", () => {
    const vault = open();
    vault.create(PASS, PASS);
    vault.put("a", newKey());
    vault.remove("a");
    expect(vault.has("a")).toBe(false);
    expect(() => vault.get("a")).toThrow(expect.objectContaining({ code: "no-key" }));
  });
});

describe("br-VAULT-000001-sJpO9KMY: keys for external tools", () => {
  it("writes an owner-only key file and deletes it after use", async () => {
    const vault = open();
    vault.create(PASS, PASS);
    const key = newKey();
    vault.put("a", key);
    let seen = "";
    const file = await vault.withKeyFile("a", (f) => {
      seen = readFileSync(f, "utf8");
      if (POSIX) expect(statSync(f).mode & 0o777).toBe(0o600);
      if (POSIX) expect(statSync(path.dirname(f)).mode & 0o777).toBe(0o700);
      return f;
    });
    expect(seen).toBe(key);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(path.dirname(file))).toBe(false);
  });

  it("deletes the key file when the tool throws", async () => {
    const vault = open();
    vault.create(PASS, PASS);
    vault.put("a", newKey());
    let used = "";
    await expect(
      vault.withKeyFile("a", async (f) => {
        used = f;
        throw new Error("ssh failed");
      }),
    ).rejects.toThrow("ssh failed");
    expect(existsSync(used)).toBe(false);
  });
});

describe("br-VAULT-000004-sJpO9KMY: passphrase rules", () => {
  it("needs no passphrase with safe storage", () => {
    const vault = open(fakeSafeStorage());
    expect(vault.state).toBe("none");
    expect(vault.needsPassphrase()).toBe(false);
    vault.create();
    expect(vault.state).toBe("unlocked");
    expect(open(fakeSafeStorage()).state).toBe("unlocked");
  });

  it.each([
    [undefined, undefined, "passphrase-short"],
    ["short", "short", "passphrase-short"],
    ["1234567", "1234567", "passphrase-short"],
    [PASS, "correct horsE", "passphrase-mismatch"],
  ])("refuses %j confirmed as %j", (passphrase, confirmation, code) => {
    expect(() => open().create(passphrase, confirmation)).toThrow(
      expect.objectContaining({ code }),
    );
    expect(existsSync(dir)).toBe(false);
  });

  it("never creates a second vault over the first", () => {
    const vault = open();
    vault.create(PASS, PASS);
    vault.put("a", newKey());
    for (const again of [vault, open(), open(fakeSafeStorage())]) {
      expect(() => again.create("another passphrase", "another passphrase")).toThrow(
        expect.objectContaining({ code: "exists" }),
      );
    }
    const reopened = open();
    reopened.unlock(PASS);
    expect(reopened.get("a")).toContain("PRIVATE KEY");
  });

  it("refuses a wrong passphrase and accepts the right one", () => {
    open().create(PASS, PASS);
    const vault = open();
    expect(vault.state).toBe("locked");
    expect(() => vault.unlock("wrong passphrase")).toThrow(
      expect.objectContaining({ code: "wrong-passphrase" }),
    );
    expect(vault.state).toBe("locked");
    vault.unlock(PASS);
    expect(vault.state).toBe("unlocked");
  });

  it("refuses to read or write while locked, and lock forgets the key", () => {
    const vault = open();
    vault.create(PASS, PASS);
    vault.put("a", newKey());
    vault.lock();
    expect(vault.state).toBe("locked");
    expect(() => vault.get("a")).toThrow(expect.objectContaining({ code: "locked" }));
    expect(() => vault.put("b", newKey())).toThrow(expect.objectContaining({ code: "locked" }));
  });

  it("refuses to store anything before the vault exists", () => {
    expect(() => open().put("a", newKey())).toThrow(expect.objectContaining({ code: "no-vault" }));
  });

  it("is a VaultError whose message holds no secret", () => {
    open().create(PASS, PASS);
    try {
      open().unlock("my secret guess");
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError);
      expect((error as Error).message).not.toContain("my secret guess");
    }
  });
});

describe("br-VAULT-000004-sJpO9KMY: never re-keyed", () => {
  it("refuses a new vault beside key files whose vault.json is gone", () => {
    const vault = open();
    vault.create(PASS, PASS);
    vault.put("a", newKey());
    rmSync(path.join(dir, META_FILE));
    expect(() => open().create(PASS, PASS)).toThrow(expect.objectContaining({ code: "exists" }));
    expect(existsSync(path.join(dir, META_FILE))).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith(".key"))).toHaveLength(1);
  });
});

describe("br-VAULT-000005-sJpO9KMY: orphaned key files", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const T0 = Date.UTC(2026, 10, 21);

  function threeKeys() {
    const vault = open();
    vault.create(PASS, PASS);
    for (const id of ["a", "b", "c"]) vault.put(id, newKey());
    return vault;
  }

  it("finds key files whose id is no longer in use", () => {
    const vault = threeKeys();
    expect(vault.findOrphans(["a", "b", "c"])).toEqual([]);
    expect(vault.findOrphans(["a"])).toHaveLength(2);
  });

  it("sets them aside, keeps them 30 days, then deletes them", () => {
    const vault = threeKeys();
    const kept = vault.get("a");
    const first = vault.cleanUpOrphans(["a"], T0);
    expect(first.moved).toHaveLength(2);
    expect(vault.has("b")).toBe(false);
    expect(vault.get("a")).toBe(kept);
    const aside = readdirSync(path.join(dir, ORPHANS_DIR));
    expect(aside).toHaveLength(2);
    expect(aside.every((f) => f.endsWith(`.key.${T0}`))).toBe(true);
    if (POSIX) expect(statSync(path.join(dir, ORPHANS_DIR)).mode & 0o777).toBe(0o700);

    expect(vault.cleanUpOrphans(["a"], T0 + ORPHAN_KEEP_MS)).toEqual({
      moved: [],
      restored: [],
      deleted: [],
    });
    const late = vault.cleanUpOrphans(["a"], T0 + ORPHAN_KEEP_MS + DAY);
    expect(late.deleted).toHaveLength(2);
    expect(readdirSync(path.join(dir, ORPHANS_DIR))).toEqual([]);
    expect(vault.get("a")).toBe(kept);
  });

  it("restores a key whose id is in use again", () => {
    const vault = threeKeys();
    const b = vault.get("b");
    vault.cleanUpOrphans(["a"], T0);
    const back = vault.cleanUpOrphans(["a", "b"], T0 + DAY);
    expect(back).toEqual({ moved: [], restored: ["b"], deleted: [] });
    expect(vault.get("b")).toBe(b);
  });

  it("never brings an old key back over a newer one", () => {
    const vault = threeKeys();
    vault.cleanUpOrphans(["a"], T0);
    const fresh = newKey();
    vault.put("b", fresh);
    expect(vault.cleanUpOrphans(["a", "b"], T0 + DAY).restored).toEqual([]);
    expect(vault.get("b")).toBe(fresh);
  });
});

describe("br-VAULT-000007-sJpO9KMY: a new key replaces the working one only once proven", () => {
  it("keeps the working key, byte for byte, when the proof fails", async () => {
    const vault = open();
    vault.create(PASS, PASS);
    const working = newKey();
    vault.put("sump", working);
    const before = everything();
    await expect(
      vault.replace("sump", newKey(), () => {
        throw new Error("Permission denied (publickey)");
      }),
    ).rejects.toThrow("Permission denied");
    expect(vault.get("sump")).toBe(working);
    expect(everything()).toBe(before);
  });

  it("stores the new key once the proof succeeds", async () => {
    const vault = open();
    vault.create(PASS, PASS);
    vault.put("sump", newKey());
    const next = newKey();
    const proved: string[] = [];
    await vault.replace("sump", next, async (pem) => {
      proved.push(pem);
    });
    expect(proved).toEqual([next]);
    expect(vault.get("sump")).toBe(next);
  });

  it("refuses a key that is not PEM before proving anything", async () => {
    const vault = open();
    vault.create(PASS, PASS);
    let proved = false;
    await expect(
      vault.replace("sump", "not a key", () => {
        proved = true;
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "not-pem" }));
    expect(proved).toBe(false);
  });
});
