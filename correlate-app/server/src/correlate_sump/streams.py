"""The Sump's data streams, whichever plugin collects them
(br-PLUGIN-000010-sJpO9KMY, REQ-000056-sJpO9KMY; moved from the SSH plugin,
REQ-000025-sJpO9KMY).

A data stream is one source the Sump collects: a Docker host ("self", or one
reached over SSH), a log-sump host, an Elasticsearch-backed system... Each
plugin that has streams registers a `StreamKind` for them
(`register_stream_kind`); the core keeps every stream in one store and holds
the stream rules for all of them alike: the followed set
(br-STREAM-000002), pause, removal (br-STREAM-000004), who added it and
privacy (br-STREAM-000006 to -000008). A kind does only its own part:
making a stream from what the app sends, listing what runs there,
collecting a followed set, and forgetting what it kept.

The store is the SSH plugin's file as it was (`SUMP_DATA_DIR/streams.json`,
owner-only, decided in FEAT-000026-sJpO9KMY), so a Sump's saved streams
load unchanged.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger(__name__)

#: The stream of the Sump's own host.
SELF_ID = "self"
#: A container or service name, as Docker allows them.
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$")


class StreamError(ValueError):
    """A stream or a followed set the Sump refuses, saying why (422)."""


class StreamRefused(Exception):
    """A stream call refused for a reason of its kind's: an HTTP status and why."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass(frozen=True)
class StreamDef:
    """One data stream. `user`, `host` and `port` say where it is reached
    (an SSH stream's; another kind's as fits it); `name` is its label when
    its kind gives one."""

    id: str
    kind: str
    user: str = ""
    host: str = ""
    port: int = 22
    name: str = ""

    @property
    def label(self) -> str:
        if self.name:
            return self.name
        if self.kind == "self":
            return "This Sump's host"
        if self.kind == "ssh":
            return f"{self.user}@{self.host}" + ("" if self.port == 22 else f":{self.port}")
        return self.id


@dataclass
class Followed:
    """What the Sump follows on one stream: its targets' names (containers,
    or what the stream's kind collects) and services."""

    containers: list[str] = field(default_factory=list)
    services: list[str] = field(default_factory=list)


def check_names(names: object, what: str) -> list[str]:
    """Target or service names, each as Docker allows, without repeats."""
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
        #: Who added each stream (br-STREAM-000006); none kept: the owner's.
        self._creators: dict[str, str] = {}
        #: Private streams (br-STREAM-000007): seen by their creator and the owner.
        self._private: set[str] = set()
        if path.exists():
            saved = json.loads(path.read_text(encoding="utf-8"))
            self._paused = set(saved.get("paused", []))
            self._secondaries = dict(saved.get("secondaries", {}))
            self._creators = {str(k): str(v) for k, v in saved.get("creators", {}).items()}
            self._private = set(saved.get("private", []))
            for s in saved.get("streams", []):
                stream = StreamDef(**{k: v for k, v in s.items() if k in _FIELDS})
                self._streams[stream.id] = stream
            for sid, f in saved.get("followed", {}).items():
                self._followed[sid] = Followed(f.get("containers", []), f.get("services", []))

    def streams(self) -> list[StreamDef]:
        """The SSH streams kept, oldest first ("self" is not kept: it is detected)."""
        return list(self._streams.values())

    def get(self, stream_id: str) -> StreamDef | None:
        return self._streams.get(stream_id)

    def add(
        self, stream: StreamDef, created_by: str | None = None, private: bool = False
    ) -> StreamDef:
        """Keep an SSH stream, and who added it; adding one already kept keeps
        the first, its creator and privacy."""
        with self._lock:
            if stream.id not in self._streams:
                self._streams[stream.id] = stream
                if created_by:
                    self._creators[stream.id] = created_by
                if private:
                    self._private.add(stream.id)
            self._save()
        return self._streams[stream.id]

    def remove(self, stream_id: str) -> StreamDef | None:
        """Forget an SSH stream: its definition, followed set and paused mark."""
        with self._lock:
            stream = self._streams.pop(stream_id, None)
            self._followed.pop(stream_id, None)
            self._paused.discard(stream_id)
            self._creators.pop(stream_id, None)
            self._private.discard(stream_id)
            self._save()
        return stream

    def creator(self, stream_id: str) -> str | None:
        """Who added the stream; None for "self" and streams from before (the owner's)."""
        return self._creators.get(stream_id)

    def private(self, stream_id: str) -> bool:
        return stream_id in self._private

    def set_private(self, stream_id: str, private: bool) -> None:
        """Make a stream private (its creator and the owner only) or shared."""
        with self._lock:
            if private:
                self._private.add(stream_id)
            else:
                self._private.discard(stream_id)
            self._save()

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
            "creators": self._creators,
            "private": sorted(self._private),
        }
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, self.path)


#: A stream's saved fields: older files lack `name`, newer kinds may add none.
_FIELDS = {"id", "kind", "user", "host", "port", "name"}


class StreamKind(Protocol):
    """What a plugin implements for its data streams (br-PLUGIN-000010)."""

    @property
    def kinds(self) -> tuple[str, ...]:
        """The `kind` values of its streams (e.g. `("self", "ssh")`)."""
        ...

    def detected(self) -> list[StreamDef]:
        """Streams it finds rather than keeps (e.g. "self"), listed first."""
        ...

    async def create(self, body: dict[str, Any]) -> StreamDef:
        """A new stream from what the app sent, once it answers; raises
        `StreamError` (422) or `StreamRefused`."""
        ...

    async def targets(self, stream: StreamDef) -> dict[str, Any]:
        """What runs there: `containers` (`{id, name, image}`) and `services`
        (or None); raises `StreamRefused`."""
        ...

    def check_follow(self, stream: StreamDef) -> None:
        """Raise `StreamRefused` when its followed set may not change now."""
        ...

    def apply(self, stream: StreamDef, followed: Followed) -> None:
        """Collect exactly `followed` on `stream` (nothing: stop)."""
        ...

    def removed(self, stream: StreamDef) -> None:
        """Forget what it kept for `stream`, now removed; raise
        `StreamRefused` before anything is removed for one it cannot be."""
        ...

    def describe(self, stream: StreamDef) -> dict[str, Any]:
        """Fields of its own for `GET /streams` (e.g. a secondary)."""
        ...


class StreamRegistry:
    """Every plugin's data streams, in one store, the stream rules held for all."""

    def __init__(self, path: Path, owner: Callable[[], str | None]) -> None:
        self._path = path
        self._owner = owner
        self._store: StreamStore | None = None
        self._kinds: list[StreamKind] = []

    def add_kind(self, kind: StreamKind) -> None:
        """Register a plugin's stream kind; its `kind` values are its alone."""
        taken = {k for known in self._kinds for k in known.kinds}
        clash = taken.intersection(kind.kinds)
        if clash:
            raise ValueError(f"stream kind {sorted(clash)} is already registered")
        self._kinds.append(kind)

    def store(self) -> StreamStore:
        """The streams' store, made on first use in an owner-only folder."""
        if self._store is None:
            self._path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            self._store = StreamStore(self._path)
        return self._store

    def owner(self) -> str | None:
        try:
            return self._owner()
        except Exception:  # noqa: BLE001 - a corrupt user store owns nothing
            return None

    def kind_of(self, stream: StreamDef) -> StreamKind | None:
        return next((k for k in self._kinds if stream.kind in k.kinds), None)

    def kind_named(self, name: str) -> StreamKind | None:
        return next((k for k in self._kinds if name in k.kinds), None)

    def streams(self) -> list[StreamDef]:
        """Every kind's detected streams first, then the kept ones whose kind is here."""
        found = [s for k in self._kinds for s in k.detected()]
        seen = {s.id for s in found}
        kept = [s for s in self.store().streams() if s.id not in seen and self.kind_of(s)]
        return found + kept

    def stream(self, stream_id: str) -> StreamDef | None:
        return next((s for s in self.streams() if s.id == stream_id), None)

    def creator(self, stream_id: str) -> str | None:
        """Who added it; the Sump's owner for detected streams and those from
        before (br-STREAM-000006-sJpO9KMY)."""
        return self.store().creator(stream_id) or self.owner()

    def may_see(self, stream_id: str, user: str | None) -> bool:
        """Shared, or the caller its creator or the owner (br-STREAM-000007)."""
        if not self.store().private(stream_id):
            return True
        return user is not None and user in (self.creator(stream_id), self.owner())

    def may_change(self, stream_id: str, user: str | None) -> bool:
        """The caller is its creator or the owner (br-STREAM-000008)."""
        return user is not None and user in (self.creator(stream_id), self.owner())

    def source_hidden(self, source: str, user: str | None) -> bool | None:
        """Whether a stream's source (`<stream>/<name>`) is hidden from `user`;
        None for a source that is no stream's."""
        stream_id, sep, _name = source.partition("/")
        if not sep or self.stream(stream_id) is None:
            return None
        return not self.may_see(stream_id, user)

    def set_followed(self, stream: StreamDef, followed: Followed) -> Followed:
        """Exactly `followed`, saved; a paused stream resumed; collection following."""
        kind = self.kind_of(stream)
        if kind is not None:
            kind.check_follow(stream)
        kept = self.store().set_followed(stream.id, followed)
        self.store().set_paused(stream.id, False)
        if kind is not None:
            kind.apply(stream, kept)
        return kept

    def pause(self, stream: StreamDef, paused: bool) -> None:
        """Close Data Streams: collection stops, the followed set kept; or resume."""
        self.store().set_paused(stream.id, paused)
        kind = self.kind_of(stream)
        if kind is not None:
            kind.apply(stream, Followed() if paused else self.store().followed(stream.id))
        logger.info("streams: %s %s", stream.id, "paused" if paused else "resumed")

    def remove(self, stream: StreamDef) -> None:
        """Stop its collection, then forget it (br-STREAM-000004); its records stay."""
        kind = self.kind_of(stream)
        if kind is not None:
            kind.removed(stream)
            kind.apply(stream, Followed())
        self.store().remove(stream.id)
        logger.info("streams: removed %s; its collection stopped", stream.id)

    def resume(self, kind: StreamKind) -> None:
        """At start: collect again what `kind`'s streams followed (not paused,
        not promoted)."""
        for stream_id, followed in self.store().all_followed().items():
            stream = self.stream(stream_id)
            if stream is not None and stream.kind in kind.kinds:
                kind.apply(stream, followed)
