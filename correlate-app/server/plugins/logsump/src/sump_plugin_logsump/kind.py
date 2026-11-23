"""The log-sump stream kind (br-PLUGIN-000010, br-STREAM-000010 to
-000011-sJpO9KMY, REQ-000057-sJpO9KMY): one data stream per log-sump Docker
host, `logsump:<docker host>@<server>`. The core keeps the streams and their
rules; this kind checks a new one against log-sump's catalog, keeps its URL
and key owner-only (never returned), lists its containers, and forgets them.
The relay (`relay.py`) collects.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

from correlate_sump.streams import Followed, StreamDef, StreamError, StreamRefused
from sump_plugin_logsump.client import LogSumpClient, LogSumpError
from sump_plugin_logsump.secrets import LogSumpStore

#: A Docker host's id in log-sump's catalog: no character that would leave a source name.
_HOST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
KIND = "logsump"
#: How far back a stream's targets are looked for.
_HOUR = timedelta(hours=1)


def check_server(url: object, api_key: object) -> tuple[str, str]:
    """A log-sump's URL (http or https, a host) and API key; `StreamError` if not."""
    if not isinstance(url, str) or urlsplit(url).scheme not in ("http", "https"):
        raise StreamError("a log-sump's URL starts http:// or https://")
    if not urlsplit(url).hostname:
        raise StreamError("a log-sump's URL names its host")
    if not isinstance(api_key, str) or not api_key.strip():
        raise StreamError("a log-sump's API key is needed")
    return url.rstrip("/"), api_key.strip()


def stream_id_for(url: str, docker_host: str) -> str:
    """`logsump:<docker host>@<server>`: two servers' hosts never meet."""
    return f"{KIND}:{docker_host}@{urlsplit(url).netloc}"


class LogSumpStreamKind:
    """log-sump Docker hosts as data streams."""

    kinds: tuple[str, ...] = (KIND,)

    def __init__(
        self,
        store: Callable[[], LogSumpStore],
        client: Callable[[str, str], LogSumpClient] = LogSumpClient,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._store = store
        self._client = client
        self._now = now

    def client_for(self, stream_id: str) -> LogSumpClient | None:
        entry = self._store().get(stream_id)
        return self._client(entry["url"], entry["api_key"]) if entry else None

    def detected(self) -> list[StreamDef]:
        return []

    async def create(self, body: dict[str, Any]) -> StreamDef:
        """A Docker host of a log-sump, once its catalog lists it for this key."""
        url, key = check_server(body.get("url"), body.get("api_key"))
        docker_host = body.get("docker_host")
        if not isinstance(docker_host, str) or not _HOST_ID.match(docker_host):
            raise StreamError("choose a Docker host from the log-sump's catalog")
        try:
            hosts = await self._client(url, key).catalog()
        except LogSumpError as exc:
            raise StreamRefused(502, str(exc)) from None
        if docker_host not in {str(h.get("id")) for h in hosts}:
            raise StreamRefused(403, f"this API key may not read {docker_host} on that log-sump")
        stream_id = stream_id_for(url, docker_host)
        server = urlsplit(url).netloc
        stream = StreamDef(
            stream_id, KIND, host=docker_host, name=f"{docker_host} (log-sump {server})"
        )
        # A stream kept already keeps its own server and key: never replaced here.
        if self._store().get(stream_id) is None:
            now = self._now().isoformat()
            self._store().put(
                stream_id,
                {
                    "url": url,
                    "api_key": key,
                    "docker_host": docker_host,
                    "start_at": now,
                    "since": now,
                    "seen": [],
                },
            )
        return stream

    async def targets(self, stream: StreamDef) -> dict[str, Any]:
        """The containers its catalog watches and its last hour's records name."""
        entry, client = self._store().get(stream.id), self.client_for(stream.id)
        if entry is None or client is None:
            raise StreamRefused(503, f"data stream {stream.id} has no log-sump")
        try:
            hosts = await client.catalog()
            now = self._now()
            page = await client.records(
                entry["docker_host"],
                start=(now.replace(microsecond=0) - _HOUR).isoformat(),
                end=now.isoformat(),
            )
        except LogSumpError as exc:
            raise StreamRefused(502, str(exc)) from None
        names: set[str] = set()
        for host in hosts:
            if host.get("id") == entry["docker_host"]:
                names.update(str(c) for c in host.get("watched_containers") or [])
        for record in page.get("records", []):
            name = record.get("container_name") if isinstance(record, dict) else None
            if name and record.get("container_id") != "__system__":
                names.add(str(name))
        return {
            "containers": [{"id": n, "name": n, "image": "log-sump"} for n in sorted(names)],
            "services": None,
        }

    def check_follow(self, stream: StreamDef) -> None:
        return None

    def apply(self, stream: StreamDef, followed: Followed) -> None:
        """The relay reads the followed sets on each poll: nothing to start here."""
        return None

    def removed(self, stream: StreamDef) -> None:
        """Its server, key and place forgotten."""
        self._store().remove(stream.id)

    def describe(self, stream: StreamDef) -> dict[str, Any]:
        """Its server's URL (the key never)."""
        entry = self._store().get(stream.id)
        return {"server": entry["url"]} if entry else {}
