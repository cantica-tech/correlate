/**
 * The vault's two ways to encrypt (br-VAULT-000001-sJpO9KMY,
 * REQ-000008-sJpO9KMY Requirement 2): the operating system's safe storage
 * when it really encrypts, otherwise AES-256-GCM under a key derived from a
 * passphrase with scrypt.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "node:crypto";

/** The part of Electron's `safeStorage` the vault uses (injected, so tests can fake it). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only: which backend Electron picked. */
  getSelectedStorageBackend?(): string;
}

/**
 * Whether safe storage really encrypts: Electron says it is available, and on
 * Linux its backend is not `basic_text`, which only obfuscates (decided in
 * FEAT-000009-sJpO9KMY).
 */
export function safeStorageUsable(safeStorage: SafeStorageLike | undefined): boolean {
  if (!safeStorage?.isEncryptionAvailable()) return false;
  return safeStorage.getSelectedStorageBackend?.() !== "basic_text";
}

/** scrypt's cost parameters. */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** About 128 MiB and a fraction of a second: the default for new vaults. */
export const SCRYPT_DEFAULT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

/** Derive the 32-byte key a passphrase unlocks. */
export function deriveKey(passphrase: string, salt: Buffer, params: ScryptParams): Buffer {
  const maxmem = 128 * params.N * params.r * params.p + 32 * 1024 * 1024;
  return scryptSync(passphrase.normalize("NFC"), salt, 32, { ...params, maxmem });
}

/** One AES-256-GCM ciphertext with its nonce and tag, all base64. */
export interface SealedBox {
  iv: string;
  tag: string;
  data: string;
}

/**
 * Encrypt `plaintext` under `key` with a fresh 12-byte nonce. `aad` (the
 * secret's id) is authenticated too, so the box opens only for that id.
 */
export function seal(key: Buffer, plaintext: Buffer, aad: string): SealedBox {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

/** Decrypt a box; throws when the key, the id or any byte is wrong. */
export function unseal(key: Buffer, box: SealedBox, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]);
}

/** A file name for `id`: HMAC-SHA-256 under the vault's own random key, base64url. */
export function fileNameFor(nameKey: Buffer, id: string): string {
  return `${createHmac("sha256", nameKey).update(id, "utf8").digest("base64url")}.key`;
}
