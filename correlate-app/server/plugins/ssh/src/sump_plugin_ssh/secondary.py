"""Reaching a promoted stream's secondary Sump (br-FED-000002-sJpO9KMY,
REQ-000052-sJpO9KMY step 2): only through the parent's own SSH forward to
the secondary's loopback port, logged in with the parent's key.

`Forward` listens on the parent's loopback, on a port the system picks, and
relays each connection over one SSH session to `127.0.0.1:<port>` on the
host. The session is opened on the first connection and opened again after
it drops. `SecondaryClient` logs in as `parent-<name>` (a challenge signed
with the Sump's key, as the app logs in) and logs in again when its token
is refused; what went wrong last is kept, to be said on the stream.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

import httpx
from cryptography.hazmat.primitives import serialization

from correlate_sump.sshsig import LOGIN_NAMESPACE, sign

logger = logging.getLogger(__name__)

#: How long one request to the secondary may take.
REQUEST_TIMEOUT_S = 20.0
#: How much one relay read moves at a time.
CHUNK = 65536
#: Records asked for per page (the Sump's `MAX_LIMIT`), and at most how many pages.
RECORDS_PAGE = 1000
MAX_PAGES = 200


class ChannelLike(Protocol):
    """The part of a paramiko channel a relay uses (blocking calls)."""

    def sendall(self, data: bytes) -> None: ...

    def recv(self, size: int) -> bytes: ...

    def shutdown_write(self) -> None: ...

    def close(self) -> None: ...


class Forward:
    """The parent's loopback forward to a secondary's port, over SSH."""

    def __init__(self, open_channel: Callable[[], ChannelLike], *, label: str = "") -> None:
        #: Opens one channel to the secondary's port, (re)connecting as needed;
        #: blocking, so it is run in a thread.
        self._open_channel = open_channel
        self._label = label
        self._server: asyncio.Server | None = None
        self._port: int | None = None
        #: Why the last connection could not be relayed, or None.
        self.error: str | None = None

    async def port(self) -> int:
        """The local port that reaches the secondary, listening from the first call."""
        if self._server is None or self._port is None:
            self._server = await asyncio.start_server(self._relay, "127.0.0.1", 0)
            self._port = int(self._server.sockets[0].getsockname()[1])
        return self._port

    async def close(self) -> None:
        """Stop listening; relays in flight end with their connections."""
        if self._server is not None:
            self._server.close()
            with contextlib.suppress(Exception):
                await self._server.wait_closed()
        self._server = None
        self._port = None

    async def _relay(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            channel = await asyncio.to_thread(self._open_channel)
        except Exception as exc:  # noqa: BLE001 -- kept, said on the stream
            self.error = f"no SSH forward to the secondary: {exc}"
            logger.warning("secondary %s: %s", self._label, self.error)
            writer.close()
            return
        self.error = None

        async def up() -> None:
            while data := await reader.read(CHUNK):
                await asyncio.to_thread(channel.sendall, data)
            with contextlib.suppress(Exception):
                channel.shutdown_write()

        async def down() -> None:
            while data := await asyncio.to_thread(channel.recv, CHUNK):
                writer.write(data)
                await writer.drain()
            writer.close()

        try:
            await asyncio.gather(up(), down())
        except (OSError, EOFError, ConnectionError):
            pass
        finally:
            channel.close()
            writer.close()


def ssh_channel_opener(connect: Callable[[], Any], remote_port: int) -> Callable[[], ChannelLike]:
    """An opener for `Forward`: one SSH client from `connect` (the stream's
    transport's), kept while it is up and connected again after a drop."""
    lock = threading.Lock()
    state: dict[str, Any] = {}

    def open_channel() -> ChannelLike:
        with lock:
            client = state.get("client")
            transport = client.get_transport() if client is not None else None
            if transport is None or not transport.is_active():
                if client is not None:
                    client.close()
                client = connect()
                state["client"] = client
                transport = client.get_transport()
            return transport.open_channel(
                "direct-tcpip", ("127.0.0.1", remote_port), ("127.0.0.1", 0)
            )

    return open_channel


class SecondaryError(Exception):
    """The secondary could not be reached or refused the parent."""


class SecondaryClient:
    """The parent's client of one secondary: logged in as its user there."""

    def __init__(
        self,
        user: str,
        private_key: Path,
        base_url: Callable[[], Awaitable[str]],
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._user = user
        self._private_key = private_key
        self._base_url = base_url
        self._transport = transport
        self._token: str | None = None
        #: What went wrong last, or None once a request went through.
        self.error: str | None = None

    def _key(self) -> Any:
        return serialization.load_ssh_private_key(self._private_key.read_bytes(), password=None)

    async def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=await self._base_url(), transport=self._transport, timeout=REQUEST_TIMEOUT_S
        )

    async def login(self, http: httpx.AsyncClient) -> str:
        """A session token on the secondary, for the parent's user there."""
        got = await http.post("/session/challenge", json={"user": self._user})
        if got.status_code != 200:
            raise SecondaryError(f"the secondary gave no challenge ({got.status_code})")
        challenge = str(got.json()["challenge"])
        signature = sign(self._key(), challenge.encode(), LOGIN_NAMESPACE)
        done = await http.post(
            "/session/login",
            json={"user": self._user, "challenge": challenge, "signature": signature},
        )
        if done.status_code != 200:
            raise SecondaryError(f"the secondary refused {self._user}'s login")
        self._token = str(done.json()["token"])
        return self._token

    async def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        """One request as the parent's user, logged in again once if refused.
        Raises `SecondaryError` (kept in `error`) when it cannot be made."""
        try:
            async with await self._client() as http:
                for attempt in range(2):
                    token = self._token or await self.login(http)
                    headers = {"Authorization": f"Bearer {token}"}
                    response = await http.request(method, path, headers=headers, **kwargs)
                    if response.status_code == 401 and attempt == 0:
                        self._token = None
                        continue
                    self.error = None
                    return response
        except SecondaryError as exc:
            self.error = str(exc)
            raise
        except (httpx.HTTPError, OSError) as exc:
            self.error = f"the secondary is unreachable: {exc}"
            raise SecondaryError(self.error) from exc
        self.error = f"the secondary refused {self._user}"
        raise SecondaryError(self.error)

    async def check(self) -> dict[str, Any]:
        """Whether the secondary answers the parent now: `reachable`, `error`."""
        try:
            response = await self.request("GET", "/plugins")
        except SecondaryError as exc:
            return {"reachable": False, "error": str(exc)}
        if response.status_code != 200:
            self.error = f"the secondary answered {response.status_code}"
            return {"reachable": False, "error": self.error}
        return {"reachable": True, "error": None}

    async def records(self, source: str, kind: str, start: datetime) -> list[dict[str, Any]]:
        """Every record of the secondary's `source` and `kind` from `start` on,
        oldest first (`/records`, page after page). Raises `SecondaryError`."""
        cursor_name = f"{kind}_cursor"
        params: dict[str, Any] = {
            "source": source,
            "kind": kind,
            "from": start.isoformat(),
            "to": (datetime.now(UTC) + timedelta(minutes=1)).isoformat(),
            "limit": RECORDS_PAGE,
        }
        found: list[dict[str, Any]] = []
        for _ in range(MAX_PAGES):
            response = await self.request("GET", "/records", params=params)
            if response.status_code != 200:
                self.error = f"the secondary answered {response.status_code} for {source}"
                raise SecondaryError(self.error)
            body = response.json()
            found.extend(body.get("records", []))
            cursor = body.get(f"next_{cursor_name}")
            if not cursor:
                return found
            params[cursor_name] = cursor
        logger.warning("secondary: %s %s cut at %d pages", source, kind, MAX_PAGES)
        return found
