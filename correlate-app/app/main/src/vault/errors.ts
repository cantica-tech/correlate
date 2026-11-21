/** What the vault can refuse, each with a code callers can act on (REQ-000008-sJpO9KMY). */

/** Why the vault refused. */
export type VaultErrorCode =
  | "not-pem"
  | "public-key"
  | "exists"
  | "no-vault"
  | "locked"
  | "passphrase-short"
  | "passphrase-mismatch"
  | "wrong-passphrase"
  | "safe-storage-unavailable"
  | "no-key"
  | "unreadable";

/** A refusal; its message never contains a key or a passphrase. */
export class VaultError extends Error {
  override readonly name = "VaultError";

  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
  }
}
