"""The Sump's data streams and what it follows on each (REQ-000025-sJpO9KMY
Requirements 1 and 2).

A data stream is a Docker host: "self" (the Sump's own host, through its
Docker socket, when detected) or one reached over SSH, identified by its SSH
user, host and port (`ssh:user@host:port`), so the same machine on two ports
is two streams with their own followed sets (br-STREAM-000005-sJpO9KMY). The
streams and their followed sets are kept in the Sump's data volume, owner-only
(decided in FEAT-000026-sJpO9KMY): collection goes on while the app is
closed, and resumes when the Sump restarts.
"""

from __future__ import annotations

import json
import os
import re
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

#: The stream of the Sump's own host.
SELF_ID = "self"

# The same checks as the app's SSH targets (`app/main/src/provision/plan.ts`).
_HOST = re.compile(
    r"^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*"
    r"|\[[0-9A-Fa-f:.]+\])$"
)
_USER = re.compile(r"^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$")
#: A container or service name, as Docker allows them.
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$")


class StreamError(ValueError):
    """A stream or a followed set the Sump refuses, saying why."""


@dataclass(frozen=True)
class StreamDef:
    """One data stream."""

    id: str
    kind: str  # "self" or "ssh"
    user: str = ""
    host: str = ""
    port: int = 22

    @property
    def label(self) -> str:
        if self.kind == "self":
            return "This Sump's host"
        return f"{self.user}@{self.host}" + ("" if self.port == 22 else f":{self.port}")


@dataclass
class Followed:
    """What the Sump follows on one stream: container and service names."""

    containers: list[str] = field(default_factory=list)
    services: list[str] = field(default_factory=list)


def parse_target(target: str, port: object) -> StreamDef:
    """An SSH stream from `user@host` and a port; `StreamError` if either is bad."""
    if not isinstance(target, str) or "@" not in target:
        raise StreamError("the target is user@host")
    user, host = target.rsplit("@", 1)
    if not _USER.match(user):
        raise StreamError(f"not a user name: {user!r}")
    if not _HOST.match(host):
        raise StreamError(f"not a host name: {host!r}")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise StreamError("the SSH port is a whole number from 1 to 65535")
    plain = host.strip("[]")
    return StreamDef(id=f"ssh:{user}@{host}:{port}", kind="ssh", user=user, host=plain, port=port)


def check_names(names: object, what: str) -> list[str]:
    """Container or service names, each as Docker allows, without repeats."""
    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise StreamError(f"{what} is a list of names")
    for name in names:
        if not _NAME.match(name):
            raise StreamError(f"not a {what[:-1]} name: {name!r}")
    return sorted(set(names))


class StreamStore:
    """Streams and followed sets, in one JSON file, written whole each time."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._streams: dict[str, StreamDef] = {}
        self._followed: dict[str, Followed] = {}
        #: Streams paused by Close Data Streams: their set kept, not collected.
        self._paused: set[str] = set()
        #: Promoted streams' secondaries (br-FED-000002): collected there, not here.
        self._secondaries: dict[str, dict[str, Any]] = {}
        if path.exists():
            saved = json.loads(path.read_text(encoding="utf-8"))
            self._paused = set(saved.get("paused", []))
            self._secondaries = dict(saved.get("secondaries", {}))
            for s in saved.get("streams", []):
                stream = StreamDef(**s)
                self._streams[stream.id] = stream
            for sid, f in saved.get("followed", {}).items():
                self._followed[sid] = Followed(f.get("containers", []), f.get("services", []))

    def streams(self) -> list[StreamDef]:
        """The SSH streams kept, oldest first ("self" is not kept: it is detected)."""
        return list(self._streams.values())

    def get(self, stream_id: str) -> StreamDef | None:
        return self._streams.get(stream_id)

    def add(self, stream: StreamDef) -> StreamDef:
        """Keep an SSH stream; adding one already kept keeps the first."""
        with self._lock:
            self._streams.setdefault(stream.id, stream)
            self._save()
        return self._streams[stream.id]

    def remove(self, stream_id: str) -> StreamDef | None:
        """Forget an SSH stream: its definition, followed set and paused mark."""
        with self._lock:
            stream = self._streams.pop(stream_id, None)
            self._followed.pop(stream_id, None)
            self._paused.discard(stream_id)
            self._save()
        return stream

    def paused(self, stream_id: str) -> bool:
        return stream_id in self._paused

    def set_paused(self, stream_id: str, paused: bool) -> None:
        """Pause (Close Data Streams) or resume a stream, its followed set kept."""
        with self._lock:
            if paused:
                self._paused.add(stream_id)
            else:
                self._paused.discard(stream_id)
            self._save()

    def followed(self, stream_id: str) -> Followed:
        """What is followed on `stream_id` (nothing, if never set)."""
        f = self._followed.get(stream_id)
        return Followed(list(f.containers), list(f.services)) if f else Followed()

    def all_followed(self) -> dict[str, Followed]:
        """Every stream's followed set, paused and promoted ones left out: what a start resumes."""
        return {
            sid: self.followed(sid)
            for sid in self._followed
            if sid not in self._paused and sid not in self._secondaries
        }

    def secondary(self, stream_id: str) -> dict[str, Any] | None:
        """The stream's secondary Sump, when it was promoted (REQ-000052-sJpO9KMY)."""
        found = self._secondaries.get(stream_id)
        return dict(found) if found else None

    def set_secondary(self, stream_id: str, secondary: dict[str, Any]) -> None:
        """Keep the stream's secondary: from now on it collects the stream."""
        with self._lock:
            self._secondaries[stream_id] = dict(secondary)
            self._save()

    def set_followed(self, stream_id: str, followed: Followed) -> Followed:
        """Make `stream_id`'s followed set exactly `followed`, saved before it returns."""
        with self._lock:
            self._followed[stream_id] = Followed(
                sorted(set(followed.containers)), sorted(set(followed.services))
            )
            self._save()
        return self.followed(stream_id)

    def _save(self) -> None:
        data = {
            "streams": [asdict(s) for s in self._streams.values()],
            "followed": {sid: asdict(f) for sid, f in self._followed.items()},
            "paused": sorted(self._paused),
            "secondaries": self._secondaries,
        }
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, self.path)
