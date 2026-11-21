/**
 * SSH keys and `SSHSIG` signatures in the app (br-CONN-000007-sJpO9KMY,
 * REQ-000011-sJpO9KMY Requirements 1 and 4).
 *
 * A private key comes from the vault as PEM: PKCS#8, PKCS#1 (RSA), SEC1 (EC)
 * or OpenSSH. Node's crypto reads all but OpenSSH; `ssh2` converts OpenSSH
 * keys first. Only Ed25519, ECDSA P-256/P-384/P-521 and RSA of 3072 bits or
 * more are accepted, as on the Sump. Signatures follow OpenSSH's
 * PROTOCOL.sshsig, so the Sump (and `ssh-keygen -Y verify`) can check them.
 */
import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign } from "node:crypto";
import { utils } from "ssh2";

/** The namespace every login signature is made for (the Sump's LOGIN_NAMESPACE). */
export const LOGIN_NAMESPACE = "correlate-sump-login";

/** The smallest RSA key accepted. */
export const MIN_RSA_BITS = 3072;

/** A key the app refuses to use, with the reason. */
export class SshKeyError extends Error {
  override readonly name = "SshKeyError";
}

const CURVES: Record<string, { name: string; hash: string }> = {
  "P-256": { name: "nistp256", hash: "sha256" },
  "P-384": { name: "nistp384", hash: "sha384" },
  "P-521": { name: "nistp521", hash: "sha512" },
};

/** An SSH wire `string`: a 4-byte length, then the bytes. */
function sshString(data: Buffer | string): Buffer {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** An SSH wire `mpint` from unsigned big-endian bytes. */
function mpint(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start += 1;
  let value = bytes.subarray(start);
  if (value.length > 0 && ((value[0] as number) & 0x80) !== 0) {
    value = Buffer.concat([Buffer.from([0]), value]);
  }
  return sshString(value);
}

/**
 * The private key in `pem`, checked against the policy. An OpenSSH key is
 * converted with `ssh2`; one protected by a passphrase is refused (the vault
 * already encrypts it).
 */
export function privateKeyFrom(pem: string): KeyObject {
  let key: KeyObject;
  if (pem.includes("-----BEGIN OPENSSH PRIVATE KEY-----")) {
    const parsed = utils.parseKey(pem);
    if (parsed instanceof Error) {
      const why = /passphrase|encrypted/i.test(parsed.message)
        ? "it is protected by a passphrase; remove it (the vault encrypts the key)"
        : parsed.message;
      throw new SshKeyError(`This OpenSSH key cannot be read: ${why}.`);
    }
    const one = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!one) throw new SshKeyError("This OpenSSH key file holds no key.");
    key = createPrivateKey(one.getPrivatePEM());
  } else {
    try {
      key = createPrivateKey(pem);
    } catch (error) {
      throw new SshKeyError(`This key cannot be read: ${(error as Error).message}.`);
    }
  }
  sshKeyType(key);
  return key;
}

/** The key's SSH type, refusing types outside the policy. */
export function sshKeyType(key: KeyObject): string {
  const details = key.asymmetricKeyDetails ?? {};
  switch (key.asymmetricKeyType) {
    case "ed25519":
      return "ssh-ed25519";
    case "ec": {
      const curve = CURVES[curveName(key)];
      if (!curve) throw new SshKeyError(`EC curve ${details.namedCurve} is not accepted.`);
      return `ecdsa-sha2-${curve.name}`;
    }
    case "rsa":
      if ((details.modulusLength ?? 0) < MIN_RSA_BITS) {
        throw new SshKeyError(
          `RSA keys need ${MIN_RSA_BITS} bits or more; this one has ${details.modulusLength}.`,
        );
      }
      return "ssh-rsa";
    default:
      throw new SshKeyError(`${key.asymmetricKeyType} keys are not accepted.`);
  }
}

/** The JWK curve name of an EC key ("P-256", ...). */
function curveName(key: KeyObject): string {
  return (key.export({ format: "jwk" }) as { crv?: string }).crv ?? "";
}

/** The public key in SSH wire format. */
export function publicKeyBlob(key: KeyObject): Buffer {
  const type = sshKeyType(key);
  const jwk = createPublicKey(key).export({ format: "jwk" }) as Record<string, string>;
  const b = (field: string) => Buffer.from(jwk[field] ?? "", "base64url");
  if (type === "ssh-ed25519") return Buffer.concat([sshString(type), sshString(b("x"))]);
  if (type === "ssh-rsa") return Buffer.concat([sshString(type), mpint(b("e")), mpint(b("n"))]);
  const curve = CURVES[jwk.crv ?? ""] as { name: string };
  const point = Buffer.concat([Buffer.from([4]), b("x"), b("y")]);
  return Buffer.concat([sshString(type), sshString(curve.name), sshString(point)]);
}

/** The public key as an `authorized_keys` line. */
export function publicKeyLine(key: KeyObject, comment = ""): string {
  const line = `${sshKeyType(key)} ${publicKeyBlob(key).toString("base64")}`;
  return comment ? `${line} ${comment}` : line;
}

/** The key's SHA-256 fingerprint, as `ssh-keygen -l` prints it. */
export function fingerprint(key: KeyObject): string {
  const digest = createHash("sha256").update(publicKeyBlob(key)).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** An armored `SSHSIG` signature of `message` for `namespace` (SHA-512 message hash). */
export function signSshsig(key: KeyObject, message: Buffer | string, namespace: string): string {
  const type = sshKeyType(key);
  const hashAlg = "sha512";
  const digest = createHash(hashAlg).update(message).digest();
  const magic = Buffer.from("SSHSIG");
  const signed = Buffer.concat([
    magic,
    sshString(namespace),
    sshString(""),
    sshString(hashAlg),
    sshString(digest),
  ]);
  let sigType: string;
  let sig: Buffer;
  if (type === "ssh-ed25519") {
    sigType = type;
    sig = sign(null, signed, key);
  } else if (type === "ssh-rsa") {
    sigType = "rsa-sha2-512";
    sig = sign("sha512", signed, key);
  } else {
    sigType = type;
    const curve = CURVES[curveName(key)] as { hash: string };
    const rs = sign(curve.hash, signed, { key, dsaEncoding: "ieee-p1363" });
    const half = rs.length / 2;
    sig = Buffer.concat([mpint(rs.subarray(0, half)), mpint(rs.subarray(half))]);
  }
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);
  const blob = Buffer.concat([
    magic,
    version,
    sshString(publicKeyBlob(key)),
    sshString(namespace),
    sshString(""),
    sshString(hashAlg),
    sshString(Buffer.concat([sshString(sigType), sshString(sig)])),
  ]);
  const b64 = blob.toString("base64");
  const lines = b64.match(/.{1,70}/g) ?? [];
  return ["-----BEGIN SSH SIGNATURE-----", ...lines, "-----END SSH SIGNATURE-----", ""].join("\n");
}
