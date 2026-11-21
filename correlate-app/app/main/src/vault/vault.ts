/**
 * The key vault (REQ-000008-sJpO9KMY): private keys stored under ids the
 * caller chooses, such as the user's identity key (Item 12) or a Sump's key
 * (Phase 3), and never in plaintext (br-VAULT-000001-sJpO9KMY).
 *
 * A vault is created once, in one of two modes:
 * - "safe-storage": the operating system encrypts (Keychain, DPAPI,
 *   libsecret); nothing to unlock.
 * - "passphrase": when safe storage is missing or only `basic_text`; keys are
 *   sealed with AES-256-GCM under a key scrypt derives from the passphrase,
 *   which lives in memory until `lock()` (br-VAULT-000004-sJpO9KMY).
 *
 * On disk, in the vault's folder: `vault.json` (mode, the random key file
 * names are derived with, scrypt's salt and parameters, and a check value
 * that tells a wrong passphrase at unlock) and one `<hmac>.key` per secret.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  deriveKey,
  fileNameFor,
  type SafeStorageLike,
  SCRYPT_DEFAULT,
  type ScryptParams,
  type SealedBox,
  safeStorageUsable,
  seal,
  unseal,
} from "./cipher.js";
import { VaultError } from "./errors.js";
import { withTemporaryKeyFile } from "./files.js";
import { pemPrivateKey } from "./pem.js";
import { ensurePrivateDir, writeSecretFile } from "./secure.js";

/** How a vault encrypts, fixed when it is created. */
export type VaultMode = "safe-storage" | "passphrase";

/** "none": no vault yet; "locked": a passphrase vault waiting for its passphrase. */
export type VaultState = "none" | "locked" | "unlocked";

/** The shortest passphrase accepted (br-VAULT-000004). */
export const MIN_PASSPHRASE_LENGTH = 8;

/** The metadata file's name inside the vault folder. */
export const META_FILE = "vault.json";

/** What `vault.json` holds; none of it is secret on its own. */
interface VaultMeta {
  v: 1;
  mode: VaultMode;
  /** The random key file names are derived with, base64. */
  nameKey: string;
  scrypt?: ScryptParams & { salt: string };
  /** A known value sealed under the derived key: opens only with the right passphrase. */
  check?: SealedBox;
}

/** What a `.key` file holds. */
type KeyEnvelope =
  | { v: 1; alg: "safe-storage"; data: string }
  | ({ v: 1; alg: "aes-256-gcm" } & SealedBox);

/** Where the vault reports what it does; never told a secret. */
export interface VaultLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** Options for tests and the app. */
export interface VaultOptions {
  /** scrypt parameters for a new passphrase vault; `SCRYPT_DEFAULT` otherwise. */
  scrypt?: ScryptParams;
  logger?: VaultLogger;
}

const CHECK_ID = "vault-check";
const CHECK_VALUE = Buffer.from("correlate-app vault v1", "utf8");

export class Vault {
  private meta: VaultMeta | undefined;
  private key: Buffer | undefined;
  private readonly logger: VaultLogger;

  /** Open the vault in `dir`; only its metadata is read. */
  constructor(
    readonly dir: string,
    private readonly safeStorage: SafeStorageLike | undefined,
    private readonly options: VaultOptions = {},
  ) {
    this.logger = options.logger ?? console;
    this.meta = this.readMeta();
  }

  /** "none", "locked" or "unlocked". */
  get state(): VaultState {
    if (!this.meta) return "none";
    if (this.meta.mode === "safe-storage") return "unlocked";
    return this.key ? "unlocked" : "locked";
  }

  /** How this vault encrypts, or `undefined` before it is created. */
  get mode(): VaultMode | undefined {
    return this.meta?.mode;
  }

  /** Whether creating or opening this vault needs a passphrase from the user. */
  needsPassphrase(): boolean {
    if (this.meta) return this.meta.mode === "passphrase";
    return !safeStorageUsable(this.safeStorage);
  }

  /**
   * Create the vault. Refused when one exists: an initialized vault is never
   * re-keyed (br-VAULT-000004). With usable safe storage no passphrase is
   * asked; otherwise it must be at least 8 characters and confirmed.
   */
  create(passphrase?: string, confirmation?: string): void {
    if (this.meta || existsSync(this.metaPath)) {
      throw new VaultError("exists", "A vault already exists here; it is never re-created.");
    }
    if (this.keyFiles().length > 0) {
      // A new vault here would be unable to open them, and would hide them.
      throw new VaultError(
        "exists",
        `Key files are in ${this.dir} but its ${META_FILE} is missing; ` +
          "they are left as is and no new vault is created over them.",
      );
    }
    const nameKey = randomBytes(32).toString("base64");
    let meta: VaultMeta;
    if (safeStorageUsable(this.safeStorage)) {
      meta = { v: 1, mode: "safe-storage", nameKey };
    } else {
      checkNewPassphrase(passphrase, confirmation);
      const params = this.options.scrypt ?? SCRYPT_DEFAULT;
      const salt = randomBytes(16);
      const key = deriveKey(passphrase as string, salt, params);
      meta = {
        v: 1,
        mode: "passphrase",
        nameKey,
        scrypt: { ...params, salt: salt.toString("base64") },
        check: seal(key, CHECK_VALUE, CHECK_ID),
      };
      this.key = key;
    }
    ensurePrivateDir(this.dir);
    writeSecretFile(this.metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    this.meta = meta;
    this.logger.info(`vault created in ${this.dir} (${meta.mode})`);
  }

  /** Unlock a passphrase vault; a wrong passphrase is refused and never kept. */
  unlock(passphrase: string): void {
    const meta = this.requireMeta();
    if (meta.mode !== "passphrase" || !meta.scrypt || !meta.check) return;
    const { salt, ...params } = meta.scrypt;
    const key = deriveKey(passphrase, Buffer.from(salt, "base64"), params);
    let opened: Buffer;
    try {
      opened = unseal(key, meta.check, CHECK_ID);
    } catch {
      key.fill(0);
      this.logger.warn("vault unlock refused: wrong passphrase");
      throw new VaultError("wrong-passphrase", "Wrong passphrase.");
    }
    if (opened.length !== CHECK_VALUE.length || !timingSafeEqual(opened, CHECK_VALUE)) {
      key.fill(0);
      throw new VaultError("wrong-passphrase", "Wrong passphrase.");
    }
    this.key = key;
  }

  /** Forget the derived key; the app calls this when it quits. */
  lock(): void {
    if (this.key) {
      this.key.fill(0);
      this.key = undefined;
      this.logger.info("vault locked");
    }
  }

  /** Store a PEM private key under `id`, replacing any key stored there. */
  put(id: string, key: Uint8Array | string): void {
    const pem = pemPrivateKey(key);
    const meta = this.requireMeta();
    let envelope: KeyEnvelope;
    if (meta.mode === "safe-storage") {
      const safeStorage = this.requireSafeStorage();
      const data = safeStorage.encryptString(JSON.stringify({ id, key: pem }));
      envelope = { v: 1, alg: "safe-storage", data: data.toString("base64") };
    } else {
      envelope = { v: 1, alg: "aes-256-gcm", ...seal(this.requireKey(), Buffer.from(pem), id) };
    }
    writeSecretFile(this.fileFor(id), `${JSON.stringify(envelope)}\n`);
  }

  /** Whether a key is stored under `id`. */
  has(id: string): boolean {
    return existsSync(this.fileFor(id));
  }

  /** The key stored under `id`, decrypted into memory. */
  get(id: string): string {
    const meta = this.requireMeta();
    const file = this.fileFor(id);
    if (!existsSync(file)) throw new VaultError("no-key", `No key is stored for "${id}".`);
    let envelope: KeyEnvelope;
    try {
      envelope = JSON.parse(readFileSync(file, "utf8")) as KeyEnvelope;
    } catch {
      throw new VaultError("unreadable", `The key stored for "${id}" is unreadable.`);
    }
    if (meta.mode === "safe-storage" && envelope.alg === "safe-storage") {
      const safeStorage = this.requireSafeStorage();
      let entry: { id?: unknown; key?: unknown };
      try {
        entry = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.data, "base64")));
      } catch {
        throw new VaultError("unreadable", `The key stored for "${id}" cannot be decrypted.`);
      }
      if (entry.id !== id || typeof entry.key !== "string") {
        throw new VaultError("unreadable", `The file for "${id}" holds another key.`);
      }
      return entry.key;
    }
    if (meta.mode === "passphrase" && envelope.alg === "aes-256-gcm") {
      const key = this.requireKey();
      try {
        return unseal(key, envelope, id).toString("utf8");
      } catch {
        throw new VaultError("unreadable", `The key stored for "${id}" cannot be decrypted.`);
      }
    }
    throw new VaultError("unreadable", `The key stored for "${id}" was written another way.`);
  }

  /** Delete the key stored under `id`, if any. */
  remove(id: string): void {
    rmSync(this.fileFor(id), { force: true });
  }

  /**
   * Hand the key for `id` to an external tool as a file: owner-only, deleted
   * when `use` ends, however it ends. Everything in the app uses `get`.
   */
  withKeyFile<T>(id: string, use: (file: string) => T | Promise<T>): Promise<T> {
    return withTemporaryKeyFile(this.get(id), use);
  }

  /** The names of the key files in the vault folder. */
  private keyFiles(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((name) => name.endsWith(".key"));
  }

  private get metaPath(): string {
    return path.join(this.dir, META_FILE);
  }

  private fileFor(id: string): string {
    const meta = this.requireMeta();
    return path.join(this.dir, fileNameFor(Buffer.from(meta.nameKey, "base64"), id));
  }

  /** Read `vault.json`; a corrupt one is refused, never replaced. */
  private readMeta(): VaultMeta | undefined {
    if (!existsSync(this.metaPath)) return undefined;
    try {
      const meta = JSON.parse(readFileSync(this.metaPath, "utf8")) as VaultMeta;
      if (meta.v !== 1 || (meta.mode !== "safe-storage" && meta.mode !== "passphrase")) {
        throw new Error("unknown version or mode");
      }
      if (meta.mode === "passphrase" && (!meta.scrypt || !meta.check)) {
        throw new Error("passphrase vault without its scrypt parameters or check");
      }
      return meta;
    } catch (error) {
      throw new VaultError(
        "unreadable",
        `The vault's ${META_FILE} in ${this.dir} is unreadable (${(error as Error).message}); ` +
          "it is left as is.",
      );
    }
  }

  private requireMeta(): VaultMeta {
    if (!this.meta) throw new VaultError("no-vault", "No vault has been created yet.");
    return this.meta;
  }

  private requireKey(): Buffer {
    if (!this.key) throw new VaultError("locked", "The vault is locked: enter its passphrase.");
    return this.key;
  }

  private requireSafeStorage(): SafeStorageLike {
    if (!this.safeStorage || !safeStorageUsable(this.safeStorage)) {
      throw new VaultError(
        "safe-storage-unavailable",
        "This vault uses the system's safe storage, which is not available now.",
      );
    }
    return this.safeStorage;
  }
}

/** Refuse a new passphrase that is missing, too short or not confirmed. */
function checkNewPassphrase(passphrase?: string, confirmation?: string): void {
  if (passphrase === undefined || [...passphrase].length < MIN_PASSPHRASE_LENGTH) {
    throw new VaultError(
      "passphrase-short",
      `The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`,
    );
  }
  if (passphrase !== confirmation) {
    throw new VaultError("passphrase-mismatch", "The two passphrases differ.");
  }
}
