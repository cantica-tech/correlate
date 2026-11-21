"""SSH keys and SSHSIG signatures (br-CONN-000007-sJpO9KMY, REQ-000011-sJpO9KMY
Requirement 1)."""

import base64
import shutil
import struct
import subprocess
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, padding, rsa

from correlate_sump.sshsig import (  # wire helpers, for a hand-made signature
    ARMOR_BEGIN,
    ARMOR_END,
    LOGIN_NAMESPACE,
    PublicKeyError,
    SignatureError,
    _signed_data,
    _string,
    parse_public_key,
    public_key_of,
    sign,
    verify,
)

MESSAGE = b"challenge-1234"


def new_key(kind: str):
    if kind == "ed25519":
        return ed25519.Ed25519PrivateKey.generate()
    if kind.startswith("p"):
        curve = {"p256": ec.SECP256R1(), "p384": ec.SECP384R1(), "p521": ec.SECP521R1()}[kind]
        return ec.generate_private_key(curve)
    return rsa.generate_private_key(65537, int(kind.removeprefix("rsa")))


ACCEPTED = ["ed25519", "p256", "p384", "p521", "rsa3072"]


@pytest.mark.parametrize("kind", ACCEPTED)
@pytest.mark.parametrize("hash_alg", ["sha256", "sha512"])
def test_each_accepted_key_type_signs_and_verifies(kind, hash_alg) -> None:
    key = new_key(kind)
    public = public_key_of(key, "alice@laptop")
    signature = sign(key, MESSAGE, LOGIN_NAMESPACE, hash_alg)
    assert signature.startswith("-----BEGIN SSH SIGNATURE-----\n")
    assert verify(signature, MESSAGE, LOGIN_NAMESPACE, [public]) == public


def test_key_lines_round_trip_with_their_fingerprint() -> None:
    key = public_key_of(new_key("ed25519"), "alice@laptop")
    again = parse_public_key(key.line())
    assert again.blob == key.blob and again.comment == "alice@laptop"
    assert key.fingerprint.startswith("SHA256:") and "=" not in key.fingerprint


def openssh_line(private_key) -> str:
    return (
        private_key.public_key()
        .public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
        .decode()
    )


def test_short_rsa_keys_are_refused() -> None:
    with pytest.raises(PublicKeyError, match="3072 bits"):
        parse_public_key(openssh_line(rsa.generate_private_key(65537, 2048)))


def test_dsa_keys_are_refused() -> None:
    blob = base64.b64encode(struct.pack(">I", 7) + b"ssh-dss" + b"\x00" * 16).decode()
    with pytest.raises(PublicKeyError, match="ssh-dss"):
        parse_public_key(f"ssh-dss {blob}")


@pytest.mark.parametrize("line", ["", "ssh-ed25519", "ssh-ed25519 not-base64!", "nonsense AAAA"])
def test_unreadable_key_lines(line) -> None:
    with pytest.raises(PublicKeyError):
        parse_public_key(line)


def test_a_key_type_that_does_not_match_its_data_is_refused() -> None:
    ed = openssh_line(new_key("ed25519")).split()[1]
    with pytest.raises(PublicKeyError):
        parse_public_key(f"ecdsa-sha2-nistp256 {ed}")


@pytest.fixture
def alice():
    key = new_key("ed25519")
    return key, public_key_of(key)


def test_wrong_namespace_is_refused(alice) -> None:
    key, public = alice
    with pytest.raises(SignatureError, match="namespace"):
        verify(sign(key, MESSAGE, "file"), MESSAGE, LOGIN_NAMESPACE, [public])


def test_wrong_message_is_refused(alice) -> None:
    key, public = alice
    with pytest.raises(SignatureError, match="does not match"):
        verify(sign(key, MESSAGE, LOGIN_NAMESPACE), b"other", LOGIN_NAMESPACE, [public])


def test_a_key_that_is_not_authorized_is_refused(alice) -> None:
    key, _ = alice
    other = public_key_of(new_key("ed25519"))
    with pytest.raises(SignatureError, match="not authorized"):
        verify(sign(key, MESSAGE, LOGIN_NAMESPACE), MESSAGE, LOGIN_NAMESPACE, [other])


def test_a_tampered_signature_is_refused(alice) -> None:
    key, public = alice
    lines = sign(key, MESSAGE, LOGIN_NAMESPACE).splitlines()
    blob = bytearray(base64.b64decode("".join(lines[1:-1])))
    blob[-1] ^= 1
    b64 = base64.b64encode(bytes(blob)).decode()
    tampered = "\n".join([lines[0], b64, lines[-1]])
    with pytest.raises(SignatureError):
        verify(tampered, MESSAGE, LOGIN_NAMESPACE, [public])


@pytest.mark.parametrize(
    "text", ["", "hello", "-----BEGIN SSH SIGNATURE-----\n!!\n-----END SSH SIGNATURE-----"]
)
def test_garbage_is_refused(alice, text) -> None:
    with pytest.raises(SignatureError):
        verify(text, MESSAGE, LOGIN_NAMESPACE, [alice[1]])


def test_rsa_sha1_signatures_are_refused() -> None:
    """`ssh-rsa` signatures use SHA-1; only rsa-sha2-256/512 are accepted."""
    key = new_key("rsa3072")
    public = public_key_of(key)
    data = _signed_data(LOGIN_NAMESPACE, "sha512", MESSAGE)
    sig = key.sign(data, padding.PKCS1v15(), hashes.SHA1())
    blob = (
        b"SSHSIG"
        + struct.pack(">I", 1)
        + _string(public.blob)
        + _string(LOGIN_NAMESPACE.encode())
        + _string(b"")
        + _string(b"sha512")
        + _string(_string(b"ssh-rsa") + _string(sig))
    )
    armored = "\n".join([ARMOR_BEGIN, base64.b64encode(blob).decode(), ARMOR_END])
    with pytest.raises(SignatureError, match="ssh-rsa is not accepted"):
        verify(armored, MESSAGE, LOGIN_NAMESPACE, [public])


SSH_KEYGEN = shutil.which("ssh-keygen")


def ssh_keygen_signs(tmp_path: Path) -> bool:
    if SSH_KEYGEN is None:
        return False
    probe = subprocess.run([SSH_KEYGEN, "-Y", "sign"], capture_output=True, text=True)
    return "Too few arguments" in probe.stderr or "usage" in probe.stderr.lower()


@pytest.mark.parametrize(("kind", "bits"), [("ed25519", None), ("ecdsa", "256"), ("rsa", "3072")])
def test_ssh_keygen_and_this_module_agree(tmp_path, kind, bits) -> None:
    """Interoperability with OpenSSH both ways, where ssh-keygen can sign."""
    keygen = SSH_KEYGEN
    if keygen is None or not ssh_keygen_signs(tmp_path):
        pytest.skip("ssh-keygen -Y is not available")
    key_file = tmp_path / "id"
    args = [keygen, "-q", "-t", kind, "-N", "", "-C", "alice", "-f", str(key_file)]
    subprocess.run(args + (["-b", bits] if bits else []), check=True)
    public = parse_public_key((tmp_path / "id.pub").read_text())
    message = tmp_path / "message"
    message.write_bytes(MESSAGE)

    # OpenSSH signs, this module verifies.
    subprocess.run(
        [keygen, "-Y", "sign", "-q", "-f", str(key_file), "-n", LOGIN_NAMESPACE, str(message)],
        check=True,
        capture_output=True,
    )
    signature = (tmp_path / "message.sig").read_text()
    assert verify(signature, MESSAGE, LOGIN_NAMESPACE, [public]) == public

    # This module signs, OpenSSH verifies.
    private = serialization.load_ssh_private_key(key_file.read_bytes(), password=None)
    (tmp_path / "ours.sig").write_text(sign(private, MESSAGE, LOGIN_NAMESPACE))
    (tmp_path / "allowed").write_text(f"alice {public.line()}\n")
    result = subprocess.run(
        [keygen, "-Y", "verify", "-f", str(tmp_path / "allowed"), "-I", "alice"]
        + ["-n", LOGIN_NAMESPACE, "-s", str(tmp_path / "ours.sig")],
        input=MESSAGE,
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr
