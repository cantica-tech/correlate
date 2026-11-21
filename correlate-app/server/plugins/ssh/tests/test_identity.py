"""REQ-000024-sJpO9KMY Requirement 4: the Sump's own SSH key."""

import os
import sys
from pathlib import Path

import paramiko
import pytest
from sump_plugin_ssh.identity import KEY_COMMENT, ensure_identity


def test_makes_an_ed25519_key_pair_once_and_keeps_it(tmp_path: Path) -> None:
    first = ensure_identity(tmp_path)
    public = first.public_key()
    assert public.startswith("ssh-ed25519 ")
    assert public.endswith(f" {KEY_COMMENT}")
    key = paramiko.Ed25519Key.from_private_key_file(str(first.private_key))
    assert public.split()[1] == key.get_base64()
    # A restart keeps the same key.
    assert ensure_identity(tmp_path).public_key() == public
    assert first.known_hosts.read_text() == ""


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")
def test_the_private_key_and_its_folder_are_owner_only(tmp_path: Path) -> None:
    identity = ensure_identity(tmp_path)
    assert os.stat(identity.private_key).st_mode & 0o077 == 0
    assert os.stat(identity.directory).st_mode & 0o077 == 0
    assert os.stat(identity.known_hosts).st_mode & 0o077 == 0
