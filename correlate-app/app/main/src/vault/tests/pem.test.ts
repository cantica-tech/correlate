import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeKeyText, pemPrivateKey } from "../pem.js";

// br-VAULT-000002-sJpO9KMY (REQ-000008-sJpO9KMY Requirement 1): supplied keys
// must be PEM private keys.

const pair = generateKeyPairSync("ed25519");
const KEY = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const PUBLIC = pair.publicKey.export({ type: "spki", format: "pem" }) as string;
const OPENSSH = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
-----END OPENSSH PRIVATE KEY-----
`;

/** `text` encoded as UTF-16, little or big endian, with a BOM. */
function utf16(text: string, endian: "le" | "be"): Uint8Array {
  const le = Buffer.from(`﻿${text}`, "utf16le");
  if (endian === "le") return le;
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1] as number;
    be[i + 1] = le[i] as number;
  }
  return be;
}

describe("br-VAULT-000002-sJpO9KMY: PEM private keys only", () => {
  it("accepts a PKCS#8 key and an OpenSSH key", () => {
    expect(pemPrivateKey(KEY)).toBe(KEY);
    expect(pemPrivateKey(OPENSSH)).toBe(OPENSSH);
  });

  it.each([
    ["UTF-8 with a BOM", Buffer.from(`﻿${KEY}`, "utf8")],
    ["UTF-16 LE", utf16(KEY, "le")],
    ["UTF-16 BE", utf16(KEY, "be")],
    ["UTF-16 LE without a BOM", Buffer.from(KEY, "utf16le")],
    ["CRLF line endings", Buffer.from(KEY.replace(/\n/g, "\r\n"), "utf8")],
    ["text around it", `my key:\n\n${KEY}\nthanks`],
  ])("decodes %s", (_how, input) => {
    expect(pemPrivateKey(input)).toBe(KEY);
  });

  it("strips a BOM and normalizes line endings", () => {
    expect(decodeKeyText("﻿a\r\nb\rc")).toBe("a\nb\nc");
  });

  it.each([
    ["a PEM public key", PUBLIC],
    ["an OpenSSH public key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI user@host\n"],
  ])("refuses %s, saying it is public", (_what, input) => {
    expect(() => pemPrivateKey(input)).toThrow(expect.objectContaining({ code: "public-key" }));
  });

  it.each([
    ["junk", "not a key"],
    ["a certificate", "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"],
    ["a header without its footer", "-----BEGIN PRIVATE KEY-----\nMIIB\n"],
    [
      "mismatched header and footer",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
    ],
  ])("refuses %s", (_what, input) => {
    expect(() => pemPrivateKey(input)).toThrow(expect.objectContaining({ code: "not-pem" }));
  });
});

describe("br-VAULT-000001-sJpO9KMY: scrypt at its real cost", () => {
  it("derives a 32-byte key with the default parameters", async () => {
    const { deriveKey, SCRYPT_DEFAULT } = await import("../cipher.js");
    expect(SCRYPT_DEFAULT).toEqual({ N: 2 ** 17, r: 8, p: 1 });
    const start = performance.now();
    expect(deriveKey("correct horse", Buffer.alloc(16), SCRYPT_DEFAULT)).toHaveLength(32);
    expect(performance.now() - start).toBeLessThan(5_000);
  });
});
