/**
 * Supplied keys must be PEM private keys (br-VAULT-000002-sJpO9KMY,
 * REQ-000008-sJpO9KMY Requirement 1).
 *
 * A pasted or chosen key may come as UTF-8 or UTF-16, with or without a byte
 * order mark, with Windows line endings. It is decoded and normalized, and
 * refused with a clear message unless it is a PEM private key.
 */
import { VaultError } from "./errors.js";

/** Decode supplied bytes or text: BOM stripped, CRLF and CR turned into LF. */
export function decodeKeyText(input: Uint8Array | string): string {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else if (input[0] === 0xff && input[1] === 0xfe) {
    text = new TextDecoder("utf-16le").decode(input.subarray(2));
  } else if (input[0] === 0xfe && input[1] === 0xff) {
    text = new TextDecoder("utf-16be").decode(input.subarray(2));
  } else if (input.length > 1 && input[0] !== 0 && input[1] === 0) {
    text = new TextDecoder("utf-16le").decode(input); // UTF-16 without a BOM.
  } else {
    text = new TextDecoder("utf-8").decode(input);
  }
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

const PRIVATE_KEY = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----\n[\s\S]+?\n-----END \1-----/;
const PUBLIC_KEY =
  /-----BEGIN [A-Z0-9 ]*PUBLIC KEY-----|^\s*(ssh|ecdsa-sha2|sk-ssh)-[\w@.-]+ AAAA/m;

/**
 * The PEM private key in `input`, normalized and ending with one newline.
 * Throws `VaultError` ("public-key" or "not-pem") otherwise.
 */
export function pemPrivateKey(input: Uint8Array | string): string {
  const text = decodeKeyText(input);
  const match = PRIVATE_KEY.exec(text);
  if (match) return `${match[0]}\n`;
  if (PUBLIC_KEY.test(text)) {
    throw new VaultError(
      "public-key",
      "This is a public key. Choose the private key: its first line reads " +
        '"-----BEGIN ... PRIVATE KEY-----".',
    );
  }
  throw new VaultError(
    "not-pem",
    'This is not a PEM private key: its first line should read "-----BEGIN ... PRIVATE KEY-----".',
  );
}
