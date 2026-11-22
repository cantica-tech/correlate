"""br-FED-000002-sJpO9KMY (REQ-000052-sJpO9KMY step 2): the parent reaches
its secondary only through its own SSH forward, logged in with its key."""

import asyncio
import socket
from pathlib import Path
from typing import Any

import fakeredis.aioredis
import httpx
import pytest
from sump_plugin_ssh.identity import ensure_identity
from sump_plugin_ssh.secondary import Forward, SecondaryClient, ssh_channel_opener

from correlate_sump.app import create_app
from correlate_sump.users import UserStore


class SocketChannel:
    """A channel to a local port, as paramiko's is to the host's."""

    def __init__(self, port: int) -> None:
        self.sock = socket.create_connection(("127.0.0.1", port))

    def sendall(self, data: bytes) -> None:
        self.sock.sendall(data)

    def recv(self, size: int) -> bytes:
        return self.sock.recv(size)

    def shutdown_write(self) -> None:
        self.sock.shutdown(socket.SHUT_WR)

    def close(self) -> None:
        self.sock.close()


async def _echo_server() -> tuple[asyncio.Server, int]:
    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        data = await reader.read()
        writer.write(b"pong:" + data)
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, int(server.sockets[0].getsockname()[1])


async def _ask(port: int, data: bytes) -> bytes:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    try:
        writer.write(data)
        await writer.drain()
        writer.write_eof()
        return await asyncio.wait_for(reader.read(), 5)
    except ConnectionError:
        return b""  # the forward closed it: nothing relayed
    finally:
        writer.close()


async def test_the_forward_relays_and_says_why_it_could_not() -> None:
    server, backend = await _echo_server()
    fail = [True]

    def open_channel() -> SocketChannel:
        if fail[0]:
            raise OSError("Connection refused")
        return SocketChannel(backend)

    forward = Forward(open_channel, label="ssh:ops@lab:22")
    port = await forward.port()
    assert await forward.port() == port
    assert await _ask(port, b"ping") == b""
    assert forward.error is not None and "Connection refused" in forward.error
    fail[0] = False
    assert await _ask(port, b"ping") == b"pong:ping"
    assert forward.error is None
    await forward.close()
    server.close()


def test_the_opener_keeps_one_ssh_session_and_reconnects_after_a_drop() -> None:
    class Transport:
        def __init__(self) -> None:
            self.active = True
            self.opened: list[tuple[Any, ...]] = []

        def is_active(self) -> bool:
            return self.active

        def open_channel(self, *args: Any) -> str:
            self.opened.append(args)
            return "channel"

    class Client:
        def __init__(self) -> None:
            self.transport = Transport()
            self.closed = False

        def get_transport(self) -> Transport:
            return self.transport

        def close(self) -> None:
            self.closed = True

    clients: list[Client] = []

    def connect() -> Client:
        clients.append(Client())
        return clients[-1]

    open_channel = ssh_channel_opener(connect, 8775)
    open_channel()
    open_channel()
    assert len(clients) == 1
    assert clients[0].transport.opened[0] == (
        "direct-tcpip",
        ("127.0.0.1", 8775),
        ("127.0.0.1", 0),
    )
    clients[0].transport.active = False
    open_channel()
    assert len(clients) == 2 and clients[0].closed


@pytest.fixture
def secondary(tmp_path: Path):
    """A secondary Sump (its app, in process) and the parent's identity."""
    parent = ensure_identity(tmp_path / "parent")
    store = UserStore(tmp_path / "secondary")
    store.set_owner("alice", ensure_identity(tmp_path / "owner").public_key())
    store.add_key("parent-sump", parent.public_key())
    app = create_app(
        redis_client=fakeredis.aioredis.FakeRedis(),
        env={"SUMP_DATA_DIR": str(tmp_path / "secondary")},
        start_ingest=False,
    )
    return parent, httpx.ASGITransport(app=app)


async def _url() -> str:
    return "http://secondary"


async def test_logs_in_as_the_parent_and_again_when_its_token_is_refused(secondary) -> None:
    parent, transport = secondary
    client = SecondaryClient("parent-sump", parent.private_key, _url, transport=transport)
    assert await client.check() == {"reachable": True, "error": None}
    client._token = "expired"
    assert (await client.request("GET", "/plugins")).status_code == 200
    assert client._token != "expired"


async def test_a_refused_login_and_an_unreachable_secondary_are_said(secondary, tmp_path) -> None:
    _parent, transport = secondary
    stranger = ensure_identity(tmp_path / "stranger")
    client = SecondaryClient("parent-sump", stranger.private_key, _url, transport=transport)
    status = await client.check()
    assert status["reachable"] is False
    assert "refused parent-sump's login" in status["error"]
    assert client.error == status["error"]

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        closed = s.getsockname()[1]

    async def gone() -> str:
        return f"http://127.0.0.1:{closed}"

    lost = SecondaryClient("parent-sump", stranger.private_key, gone)
    status = await lost.check()
    assert status["reachable"] is False and "unreachable" in status["error"]
