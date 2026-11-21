"""SSH public keys and `SSHSIG` signatures (br-CONN-000007-sJpO9KMY,
REQ-000011-sJpO9KMY Requirement 1).

A user logs in by signing a challenge in OpenSSH's `SSHSIG` format (what
`ssh-keygen -Y sign` makes; see OpenSSH's PROTOCOL.sshsig) with the namespace
`correlate-sump-login`. Only Ed25519, ECDSA P-256/P-384/P-521 and RSA of 3072
bits or more are accepted; RSA signatures must use SHA-2.

`sign` makes the same signatures from a `cryptography` private key, for tests
and tools; the app signs with its own implementation.
"""

from __future__ import annotations

import base64
import hashlib
import struct
from dataclasses import dataclass
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, padding, rsa
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature,
    encode_dss_signature,
)

#: The namespace every login signature is made for.
LOGIN_NAMESPACE = "correlate-sump-login"

#: The smallest RSA key accepted.
MIN_RSA_BITS = 3072

#: Key types accepted, with the hash ECDSA signs with.
ECDSA_HASHES: dict[str, type[hashes.HashAlgorithm]] = {
    "ecdsa-sha2-nistp256": hashes.SHA256,
    "ecdsa-sha2-nistp384": hashes.SHA384,
    "ecdsa-sha2-nistp521": hashes.SHA512,
}
KEY_TYPES = frozenset({"ssh-ed25519", "ssh-rsa", *ECDSA_HASHES})

#: RSA signature types accepted (SHA-2 only; `ssh-rsa` signatures use SHA-1).
RSA_SIGNATURES: dict[str, type[hashes.HashAlgorithm]] = {
    "rsa-sha2-256": hashes.SHA256,
    "rsa-sha2-512": hashes.SHA512,
}

#: Message hashes `SSHSIG` allows.
MESSAGE_HASHES = {"sha256": hashlib.sha256, "sha512": hashlib.sha512}

MAGIC = b"SSHSIG"
ARMOR_BEGIN = "-----BEGIN SSH SIGNATURE-----"
ARMOR_END = "-----END SSH SIGNATURE-----"


class PublicKeyError(ValueError):
    """A public key that cannot be read or is of a refused type."""


class SignatureError(ValueError):
    """A signature that does not verify; the message says why."""


@dataclass(frozen=True)
class PublicKey:
    """One public key: its type, wire blob, `cryptography` object and comment."""

    type: str
    blob: bytes
    key: Any
    comment: str = ""

    @property
    def fingerprint(self) -> str:
        """`SHA256:...`, as `ssh-keygen -l` prints it."""
        digest = base64.b64encode(hashlib.sha256(self.blob).digest()).decode().rstrip("=")
        return f"SHA256:{digest}"

    def line(self) -> str:
        """The key as an `authorized_keys` line."""
        text = f"{self.type} {base64.b64encode(self.blob).decode()}"
        return f"{text} {self.comment}" if self.comment else text


def _string(data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + data


def _mpint(value: int) -> bytes:
    raw = value.to_bytes((value.bit_length() + 8) // 8, "big") if value else b""
    return _string(raw)


class _Reader:
    """Reads SSH wire fields, refusing anything truncated."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.at = 0

    def take(self, n: int) -> bytes:
        if self.at + n > len(self.data):
            raise SignatureError("truncated signature")
        out = self.data[self.at : self.at + n]
        self.at += n
        return out

    def uint32(self) -> int:
        return struct.unpack(">I", self.take(4))[0]

    def string(self) -> bytes:
        return self.take(self.uint32())

    def done(self) -> bool:
        return self.at == len(self.data)


def check_key_policy(key_type: str, key: Any) -> None:
    """Refuse key types outside the policy (br-CONN-000007)."""
    if key_type not in KEY_TYPES:
        raise PublicKeyError(f"key type {key_type} is not accepted")
    if key_type == "ssh-rsa" and key.key_size < MIN_RSA_BITS:
        raise PublicKeyError(
            f"RSA keys need {MIN_RSA_BITS} bits or more, this one has {key.key_size}"
        )


def parse_public_key(line: str) -> PublicKey:
    """Read an `authorized_keys` line (no options); refuse other key types."""
    parts = line.strip().split(None, 2)
    if len(parts) < 2:
        raise PublicKeyError("not a public key line")
    key_type, b64 = parts[0], parts[1]
    if key_type not in KEY_TYPES:
        raise PublicKeyError(f"key type {key_type} is not accepted")
    try:
        blob = base64.b64decode(b64, validate=True)
        key = serialization.load_ssh_public_key(f"{key_type} {b64}".encode())
    except Exception as exc:
        raise PublicKeyError(f"unreadable {key_type} key: {exc}") from exc
    if _Reader(blob).string().decode(errors="replace") != key_type:
        raise PublicKeyError("the key's type does not match its data")
    check_key_policy(key_type, key)
    return PublicKey(key_type, blob, key, parts[2].strip() if len(parts) > 2 else "")


def _signed_data(namespace: str, hash_alg: str, message: bytes) -> bytes:
    digest = MESSAGE_HASHES[hash_alg](message).digest()
    return (
        MAGIC
        + _string(namespace.encode())
        + _string(b"")
        + _string(hash_alg.encode())
        + _string(digest)
    )


def _unarmor(armored: str) -> bytes:
    text = armored.strip()
    if not (text.startswith(ARMOR_BEGIN) and text.endswith(ARMOR_END)):
        raise SignatureError("not an armored SSH signature")
    body = "".join(text[len(ARMOR_BEGIN) : -len(ARMOR_END)].split())
    try:
        return base64.b64decode(body, validate=True)
    except Exception as exc:
        raise SignatureError("the signature is not valid base64") from exc


def verify(
    armored: str,
    message: bytes,
    namespace: str,
    keys: list[PublicKey],
) -> PublicKey:
    """The key among `keys` that signed `message` for `namespace`; raises
    `SignatureError` when none did, or anything is off."""
    r = _Reader(_unarmor(armored))
    if r.take(6) != MAGIC or r.uint32() != 1:
        raise SignatureError("not an SSHSIG version 1 signature")
    blob = r.string()
    signed_namespace = r.string().decode(errors="replace")
    r.string()  # reserved
    hash_alg = r.string().decode(errors="replace")
    signature = r.string()
    if not r.done():
        raise SignatureError("trailing data after the signature")
    if signed_namespace != namespace:
        raise SignatureError(f"signed for namespace {signed_namespace!r}, not {namespace!r}")
    if hash_alg not in MESSAGE_HASHES:
        raise SignatureError(f"message hash {hash_alg} is not accepted")
    key = next((k for k in keys if k.blob == blob), None)
    if key is None:
        raise SignatureError("signed with a key that is not authorized")
    s = _Reader(signature)
    sig_type = s.string().decode(errors="replace")
    sig = s.string()
    data = _signed_data(namespace, hash_alg, message)
    try:
        if key.type == "ssh-ed25519" and sig_type == "ssh-ed25519":
            key.key.verify(sig, data)
        elif key.type in ECDSA_HASHES and sig_type == key.type:
            rs = _Reader(sig)
            r_, s_ = int.from_bytes(rs.string(), "big"), int.from_bytes(rs.string(), "big")
            key.key.verify(encode_dss_signature(r_, s_), data, ec.ECDSA(ECDSA_HASHES[key.type]()))
        elif key.type == "ssh-rsa" and sig_type in RSA_SIGNATURES:
            key.key.verify(sig, data, padding.PKCS1v15(), RSA_SIGNATURES[sig_type]())
        else:
            raise SignatureError(f"signature type {sig_type} is not accepted for {key.type}")
    except InvalidSignature as exc:
        raise SignatureError("the signature does not match") from exc
    return key


def public_key_of(private_key: Any, comment: str = "") -> PublicKey:
    """The `PublicKey` of a `cryptography` private key."""
    line = (
        private_key.public_key()
        .public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
        .decode()
    )
    return parse_public_key(f"{line} {comment}".strip())


def sign(private_key: Any, message: bytes, namespace: str, hash_alg: str = "sha512") -> str:
    """An armored `SSHSIG` signature of `message` (for tests and tools)."""
    public = public_key_of(private_key)
    data = _signed_data(namespace, hash_alg, message)
    if isinstance(private_key, ed25519.Ed25519PrivateKey):
        sig_type, sig = "ssh-ed25519", private_key.sign(data)
    elif isinstance(private_key, ec.EllipticCurvePrivateKey):
        sig_type = public.type
        r_, s_ = decode_dss_signature(private_key.sign(data, ec.ECDSA(ECDSA_HASHES[sig_type]())))
        sig = _mpint(r_) + _mpint(s_)
    elif isinstance(private_key, rsa.RSAPrivateKey):
        sig_type, sig = "rsa-sha2-512", private_key.sign(data, padding.PKCS1v15(), hashes.SHA512())
    else:
        raise TypeError(f"cannot sign with {type(private_key).__name__}")
    blob = (
        MAGIC
        + struct.pack(">I", 1)
        + _string(public.blob)
        + _string(namespace.encode())
        + _string(b"")
        + _string(hash_alg.encode())
        + _string(_string(sig_type.encode()) + _string(sig))
    )
    b64 = base64.b64encode(blob).decode()
    lines = [b64[i : i + 70] for i in range(0, len(b64), 70)]
    return "\n".join([ARMOR_BEGIN, *lines, ARMOR_END]) + "\n"
