"""Fixtures of the SSH plugin's tests (REQ-000024-sJpO9KMY): the Sump's own
identity in a temporary data directory, and SSH servers that accept it.

The SSH server runs in the test process, as the app's own tests have one:
paramiko in server mode on 127.0.0.1, accepting one public key, answering
each command with a handler's lines and exit code.
"""

from __future__ import annotations

import socket
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

import paramiko
import pytest
from sump_plugin_ssh.identity import SumpIdentity, ensure_identity

#: What a command answers: stdout lines, stderr lines, exit code; or, for a
#: command that runs on, an iterable of stdout lines and a stop event.
Answer = tuple[list[str], list[str], int]
Handler = Callable[[str], "Answer | Iterable[str]"]


@dataclass
class SSHServer:
    """A running server: its port, the commands it ran, and its host key."""

    port: int
    host_key: paramiko.PKey
    commands: list[str] = field(default_factory=list)
    _stop: threading.Event = field(default_factory=threading.Event)
    _socket: socket.socket | None = None

    def close(self) -> None:
        self._stop.set()
        if self._socket is not None:
            self._socket.close()


class _Server(paramiko.ServerInterface):
    def __init__(self, allowed: paramiko.PKey, user: str) -> None:
        self.allowed = allowed
        self.user = user
        self.command: bytes | None = None
        self.exec_ready = threading.Event()

    def check_channel_request(self, kind: str, chanid: int) -> int:
        return (
            paramiko.OPEN_SUCCEEDED
            if kind == "session"
            else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
        )

    def get_allowed_auths(self, username: str) -> str:
        return "publickey"

    def check_auth_publickey(self, username: str, key: paramiko.PKey) -> int:
        ok = username == self.user and key.asbytes() == self.allowed.asbytes()
        return paramiko.AUTH_SUCCESSFUL if ok else paramiko.AUTH_FAILED

    def check_channel_exec_request(self, channel: paramiko.Channel, command: bytes) -> bool:
        self.command = command
        self.exec_ready.set()
        return True


def start_ssh_server(
    allowed: paramiko.PKey,
    handler: Handler,
    *,
    user: str = "ops",
    host_key: paramiko.PKey | None = None,
) -> SSHServer:
    """Start a server accepting `allowed` for `user`; `handler` answers commands."""
    key = host_key or paramiko.Ed25519Key.from_private_key(_new_ed25519_pem())
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    listener.settimeout(0.2)
    server = SSHServer(port=listener.getsockname()[1], host_key=key, _socket=listener)

    def serve(conn: socket.socket) -> None:
        transport = paramiko.Transport(conn)
        transport.add_server_key(key)
        iface = _Server(allowed, user)
        try:
            transport.start_server(server=iface)
            channel = transport.accept(5)
            if channel is None or not iface.exec_ready.wait(5) or iface.command is None:
                return
            command = iface.command.decode()
            server.commands.append(command)
            answer = handler(command)
            if isinstance(answer, tuple):
                out, err, code = answer
                for line in out:
                    channel.sendall(f"{line}\n".encode())
                for line in err:
                    channel.sendall_stderr(f"{line}\n".encode())
                channel.send_exit_status(code)
            else:
                # Runs on until the client goes away or the server stops.
                for line in answer:
                    if server._stop.is_set() or channel.closed:
                        break
                    channel.sendall(f"{line}\n".encode())
                while not server._stop.is_set() and not channel.closed and transport.is_active():
                    time.sleep(0.05)
            channel.close()
        except (OSError, EOFError, paramiko.SSHException):
            pass
        finally:
            transport.close()

    def accept_loop() -> None:
        while not server._stop.is_set():
            try:
                conn, _ = listener.accept()
            except (TimeoutError, OSError):
                continue
            threading.Thread(target=serve, args=(conn,), daemon=True).start()

    threading.Thread(target=accept_loop, daemon=True).start()
    return server


def _new_ed25519_pem():
    import io

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    pem = Ed25519PrivateKey.generate().private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.OpenSSH,
        serialization.NoEncryption(),
    )
    return io.StringIO(pem.decode())


@pytest.fixture
def identity(tmp_path: Path) -> SumpIdentity:
    return ensure_identity(tmp_path)


@pytest.fixture
def ssh_server(identity: SumpIdentity) -> Iterator[Callable[..., SSHServer]]:
    """Start servers accepting the Sump's key; each stops after the test."""
    started: list[SSHServer] = []
    allowed = paramiko.Ed25519Key.from_private_key_file(str(identity.private_key))

    def start(handler: Handler, **kwargs) -> SSHServer:
        server = start_ssh_server(allowed, handler, **kwargs)
        started.append(server)
        return server

    yield start
    for server in started:
        server.close()
