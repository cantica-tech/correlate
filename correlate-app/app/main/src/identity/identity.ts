/**
 * The user's identity: one SSH key pair, the private key in the vault under
 * `IDENTITY_ID` (br-CONN-000007-sJpO9KMY, REQ-000011-sJpO9KMY Requirement 4).
 * A new Ed25519 key is generated the first time; an existing key can be
 * imported instead (decided in FEAT-000012-sJpO9KMY).
 */
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { userInfo } from "node:os";
import type { Vault } from "../vault/vault.js";
import { privateKeyFrom, publicKeyLine } from "./sshkey.js";

/** The vault id the identity key is stored under. */
export const IDENTITY_ID = "identity";

/** The comment on the identity's public key. */
export const KEY_COMMENT = "correlate-app";

/** The identity's private key, generating a new Ed25519 key when none is stored. */
export function ensureIdentity(vault: Vault): KeyObject {
  if (!vault.has(IDENTITY_ID)) {
    const pem = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    vault.put(IDENTITY_ID, pem);
  }
  return privateKeyFrom(vault.get(IDENTITY_ID));
}

/**
 * Use an existing private key (such as `~/.ssh/id_ed25519`) as the identity.
 * It is checked against the key policy before it is stored.
 */
export function importIdentity(vault: Vault, key: Uint8Array | string): void {
  const text = typeof key === "string" ? key : new TextDecoder().decode(key);
  privateKeyFrom(text.replace(/\r\n?/g, "\n"));
  vault.put(IDENTITY_ID, key);
}

/** The identity's public key, as an `authorized_keys` line to give a Sump's owner. */
export function identityPublicKey(vault: Vault): string {
  return publicKeyLine(ensureIdentity(vault), KEY_COMMENT);
}

/**
 * The user name the app logs in as: `CORRELATE_USER`, or the operating
 * system's user name, lowered and limited to what a Sump accepts.
 */
export function userName(env: Record<string, string | undefined>): string {
  const raw = env.CORRELATE_USER || userInfo().username;
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .slice(0, 64);
  return name === "" || name === "." || name === ".." ? "user" : name;
}
