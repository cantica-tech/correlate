"""Users, their public keys and the owner (br-CONN-000007-sJpO9KMY,
REQ-000011-sJpO9KMY Requirement 2).

Under `SUMP_DATA_DIR` (a named Docker volume in the container, since Redis
there is not saved to disk):

- `keys/<user>.authorized_keys`: the user's public keys, one
  `authorized_keys` line each (no options);
- `owner`: the owner's user name.

Files are written atomically and readable by the Sump's user only. A file
that cannot be read, or that holds a refused key type, makes the store
corrupt: `CorruptKeyStore` is raised and the file left as it is, never
rewritten (the lesson of cttc BUG-000011-uKKrzikI).

There is no route to claim a Sump: `python -m correlate_sump.users set-owner
--user NAME`, with the owner's public key on standard input, run inside the
container (by provisioning, in Phase 3), sets the owner.
"""

from __future__ import annotations

import argparse
import contextlib
import os
import re
import secrets
import sys
from collections.abc import Mapping
from pathlib import Path

from correlate_sump.sshsig import PublicKey, PublicKeyError, parse_public_key

#: Where users and keys live when `SUMP_DATA_DIR` is not set (outside the container).
DEFAULT_DATA_DIR = Path.home() / ".correlate-sump"

#: A user name: 1 to 64 of a-z, 0-9, ".", "_" and "-" (also safe as a file name).
USER_NAME = re.compile(r"^[a-z0-9._-]{1,64}$")


class CorruptKeyStore(Exception):
    """A keys or owner file that cannot be read; it is left as it is."""


class UserError(ValueError):
    """A change the store refuses: a bad name, a missing key, the owner's last key."""


def data_dir_from_env(env: Mapping[str, str]) -> Path:
    """`SUMP_DATA_DIR`, or `~/.correlate-sump`."""
    raw = env.get("SUMP_DATA_DIR", "").strip()
    return Path(raw) if raw else DEFAULT_DATA_DIR


def check_user_name(user: str) -> str:
    """`user`, if it is a valid user name; `UserError` otherwise."""
    if not USER_NAME.match(user) or user in {".", ".."}:
        raise UserError(f"user names are 1 to 64 of a-z, 0-9, '.', '_' and '-'; got {user!r}")
    return user


class UserStore:
    """The users' public keys and the owner, on disk."""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.keys_dir = data_dir / "keys"
        self.owner_file = data_dir / "owner"

    def owner(self) -> str | None:
        """The owner's user name, or `None` before one is set."""
        if not self.owner_file.exists():
            return None
        name = self._read(self.owner_file).strip()
        if not USER_NAME.match(name):
            raise CorruptKeyStore(f"{self.owner_file} does not hold a user name")
        return name

    def users(self) -> list[str]:
        """Every user with at least one key, sorted."""
        if not self.keys_dir.exists():
            return []
        return sorted(p.name.removesuffix(".authorized_keys") for p in self._key_files())

    def keys(self, user: str) -> list[PublicKey]:
        """`user`'s public keys; none for an unknown or invalid name."""
        if not USER_NAME.match(user):
            return []
        path = self._keys_file(user)
        if not path.exists():
            return []
        keys = []
        for number, line in enumerate(self._read(path).splitlines(), start=1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            try:
                keys.append(parse_public_key(line))
            except PublicKeyError as exc:
                raise CorruptKeyStore(f"{path}, line {number}: {exc}") from exc
        return keys

    def add_key(self, user: str, line: str) -> PublicKey:
        """Add a public key to `user` (a key already there is kept once)."""
        check_user_name(user)
        try:
            key = parse_public_key(line)
        except PublicKeyError as exc:
            raise UserError(str(exc)) from exc
        keys = self.keys(user)
        if all(k.blob != key.blob for k in keys):
            self._write_keys(user, [*keys, key])
        return key

    def remove_key(self, user: str, fingerprint: str) -> None:
        """Remove one of `user`'s keys; the owner's last key stays."""
        keys = self.keys(user)
        remaining = [k for k in keys if k.fingerprint != fingerprint]
        if len(remaining) == len(keys):
            raise LookupError(f"{user} has no key {fingerprint}")
        if not remaining and user == self.owner():
            raise UserError("the owner's last key cannot be removed")
        if remaining:
            self._write_keys(user, remaining)
        else:
            self._keys_file(user).unlink()

    def set_owner(self, user: str, line: str, replace: bool = False) -> PublicKey:
        """Make `user` the owner, with this public key; a different owner is
        replaced only when `replace` is true."""
        check_user_name(user)
        current = self.owner()
        if current is not None and current != user and not replace:
            raise UserError(f"{current} already owns this Sump; pass --replace to change it")
        key = self.add_key(user, line)
        self._write(self.owner_file, f"{user}\n")
        return key

    def _keys_file(self, user: str) -> Path:
        return self.keys_dir / f"{user}.authorized_keys"

    def _key_files(self) -> list[Path]:
        return [p for p in self.keys_dir.iterdir() if p.name.endswith(".authorized_keys")]

    def _write_keys(self, user: str, keys: list[PublicKey]) -> None:
        self._write(self._keys_file(user), "".join(f"{k.line()}\n" for k in keys))

    @staticmethod
    def _read(path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            raise CorruptKeyStore(f"{path} cannot be read: {exc}") from exc

    def _write(self, path: Path, text: str) -> None:
        """Write atomically, readable by the Sump's user only (br-VAULT-000006)."""
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with contextlib.suppress(OSError):
            os.chmod(path.parent, 0o700)
        temporary = path.with_name(f"{path.name}.{secrets.token_hex(6)}.tmp")
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    """`set-owner --user NAME [--replace]` (public key on standard input), or `list`."""
    parser = argparse.ArgumentParser(prog="python -m correlate_sump.users")
    sub = parser.add_subparsers(dest="command", required=True)
    owner = sub.add_parser("set-owner", help="make NAME the owner, with the key on stdin")
    owner.add_argument("--user", required=True)
    owner.add_argument("--replace", action="store_true", help="replace a different owner")
    sub.add_parser("list", help="list users and their key fingerprints")
    # A secondary Sump's parent, as a user (br-FED-000001-sJpO9KMY, REQ-000052).
    add = sub.add_parser("add-key", help="give NAME the key on stdin")
    add.add_argument("--user", required=True)
    args = parser.parse_args(argv)
    store = UserStore(data_dir_from_env(os.environ if env is None else env))
    try:
        if args.command == "set-owner":
            key = store.set_owner(args.user, sys.stdin.read().strip(), replace=args.replace)
            print(f"{args.user} owns this Sump ({key.type} {key.fingerprint})")
        elif args.command == "add-key":
            key = store.add_key(args.user, sys.stdin.read().strip())
            print(f"{args.user} may log in ({key.type} {key.fingerprint})")
        else:
            owner_name = store.owner()
            for user in store.users():
                mark = " (owner)" if user == owner_name else ""
                for key in store.keys(user):
                    print(f"{user}{mark} {key.type} {key.fingerprint} {key.comment}".rstrip())
    except (UserError, CorruptKeyStore) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
