"""The Sump's own SSH key, and the host keys it has met (REQ-000024-sJpO9KMY
Requirements 2 and 4).

Each Sump makes its own Ed25519 key pair at first start, in
`SUMP_DATA_DIR/ssh/`, the private key owner-only and never sent anywhere
(decided in FEAT-000025-sJpO9KMY); the user adds its public key to a data
stream host's `authorized_keys`. The host keys of the hosts it reaches are
kept in `known_hosts` beside it: recorded at the first connection to a host
and port, and required to match afterwards (correlator accepted any).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

#: The key's comment, so a host's `authorized_keys` says whose line it is.
KEY_COMMENT = "correlate-sump"


@dataclass(frozen=True)
class SumpIdentity:
    """Where the Sump's key pair and the known host keys are."""

    directory: Path

    @property
    def private_key(self) -> Path:
        return self.directory / "id_ed25519"

    @property
    def public_key_file(self) -> Path:
        return self.directory / "id_ed25519.pub"

    @property
    def known_hosts(self) -> Path:
        return self.directory / "known_hosts"

    def public_key(self) -> str:
        """The public key, one OpenSSH line."""
        return self.public_key_file.read_text(encoding="utf-8").strip()


def _write_owner_only(path: Path, data: bytes) -> None:
    """Write `data` to `path`, readable by its owner only, never briefly wider."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.chmod(path, 0o600)


def ensure_identity(data_dir: Path) -> SumpIdentity:
    """The Sump's key pair in `data_dir/ssh/`, made on the first call and kept after."""
    identity = SumpIdentity(data_dir / "ssh")
    identity.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(identity.directory, 0o700)
    if not identity.private_key.exists():
        key = Ed25519PrivateKey.generate()
        _write_owner_only(
            identity.private_key,
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.OpenSSH,
                serialization.NoEncryption(),
            ),
        )
        public = key.public_key().public_bytes(
            serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH
        )
        identity.public_key_file.write_bytes(public + f" {KEY_COMMENT}\n".encode())
    if not identity.known_hosts.exists():
        _write_owner_only(identity.known_hosts, b"")
    return identity
