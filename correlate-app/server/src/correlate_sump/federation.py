"""A promoted stream's records, joined at the promotion time
(br-FED-000002-sJpO9KMY, REQ-000052-sJpO9KMY step 3).

Every query reads a source's records with `xrange`/`xrevrange` on its Redis
stream (`stream_key`). `FederatedRedis` stands in for the Redis client on
the query routes: for a source a plugin says is federated (the
`federated_source` hook), it answers with this Sump's own entries before
the cut (the promotion time) and the secondary's records from the cut on,
fetched by the plugin. Every query (pages, find, density, buckets, range,
segments) then works on the joined rows unchanged.

A secondary that cannot be reached leaves its part out: the query answers
with this Sump's history, and the stream says why (`GET /streams/{id}/secondary`).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)

#: The user of the request being answered, set by the session guard: the
#: record queries hide what that user may not see (br-STREAM-000007).
CURRENT_USER: ContextVar[str | None] = ContextVar("CURRENT_USER", default=None)

#: The prefix of every record stream's key (`ingest.stream_key`).
KEY_PREFIX = "sump:records:"
#: Added to a remote entry's sequence, so its id never equals a local one.
REMOTE_SEQ = 1 << 40


@dataclass
class Federated:
    """A source collected elsewhere from `cut` on."""

    #: The promotion time: this Sump's entries before, the secondary's from it.
    cut: datetime
    #: The secondary's records of one kind from `cut` on, oldest first,
    #: named as this Sump names the source; raises when unreachable.
    fetch: Callable[[str], Awaitable[list[dict[str, Any]]]]


def parse_key(key: Any) -> tuple[str, str] | None:
    """`(source, kind)` of a record stream's key, or None for another key."""
    text = key.decode() if isinstance(key, bytes) else str(key)
    if not text.startswith(KEY_PREFIX):
        return None
    source, sep, kind = text[len(KEY_PREFIX) :].rpartition(":")
    return (source, kind) if sep and source else None


def _ts(fields: Any) -> datetime | None:
    data = fields.get(b"json", fields.get("json")) if fields else None
    if data is None:
        return None
    record = json.loads(data.decode() if isinstance(data, bytes) else data)
    try:
        return datetime.fromisoformat(record["ts"])
    except (KeyError, TypeError, ValueError):
        return None


class FederatedRedis:
    """The Redis client, with federated sources' streams joined at their cut."""

    def __init__(
        self,
        redis_client: Any,
        lookup: Callable[[str], Federated | None],
        hidden: Callable[[str, str | None], bool] | None = None,
    ) -> None:
        self._redis = redis_client
        self._lookup = lookup
        #: Whether a source is hidden from a user (br-STREAM-000007): its
        #: streams then answer as empty, as for a source that does not exist.
        self._hidden = hidden

    def _is_hidden(self, name: Any) -> bool:
        parsed = parse_key(name)
        return bool(parsed and self._hidden and self._hidden(parsed[0], CURRENT_USER.get()))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._redis, name)

    async def _joined(self, key: Any) -> list[tuple[str, dict[str, str]]] | None:
        parsed = parse_key(key)
        federated = self._lookup(parsed[0]) if parsed else None
        if parsed is None or federated is None:
            return None
        local = await self._redis.xrange(key, min="-", max="+") or []
        kept: list[tuple[Any, Any]] = []
        for entry_id, fields in local:
            ts = _ts(fields)
            if ts is not None and ts < federated.cut:
                kept.append((entry_id, fields))
        try:
            remote = await federated.fetch(parsed[1])
        except Exception as exc:  # noqa: BLE001 -- the stream says why
            logger.warning("federation: %s's secondary part is left out: %s", parsed[0], exc)
            remote = []
        for n, record in enumerate(remote):
            try:
                ts = datetime.fromisoformat(record["ts"])
            except (KeyError, TypeError, ValueError):
                continue
            if ts < federated.cut:
                continue
            entry_id = f"{int(ts.timestamp() * 1000)}-{REMOTE_SEQ + n}"
            kept.append((entry_id, {"json": json.dumps(record)}))
        return kept

    async def xrange(
        self,
        name: str,
        min: str = "-",  # noqa: A002 -- Redis's own parameter names
        max: str = "+",  # noqa: A002
        count: int | None = None,
    ) -> Any:
        """`xrange` as Redis's; a federated source's whole stream joined at its cut."""
        if self._is_hidden(name):
            return []
        joined = await self._joined(name)
        if joined is None:
            return await self._redis.xrange(name, min=min, max=max, count=count)
        return joined[:count] if count else joined

    async def xrevrange(
        self,
        name: str,
        max: str = "+",  # noqa: A002 -- Redis's own parameter names
        min: str = "-",  # noqa: A002
        count: int | None = None,
    ) -> Any:
        """`xrevrange` as Redis's; a federated source's whole stream joined at its cut."""
        if self._is_hidden(name):
            return []
        joined = await self._joined(name)
        if joined is None:
            return await self._redis.xrevrange(name, max=max, min=min, count=count)
        backwards = list(reversed(joined))
        return backwards[:count] if count else backwards
