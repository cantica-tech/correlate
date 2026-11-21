"""The time range the Sump holds for some sources (REQ-000031-sJpO9KMY
Requirement 3): the earliest and latest record of any kind, for the live
view's navigator, which shows the view within it (cttc's `/range`).

Each source's streams are read at their ends only: records arrive in time
order closely enough for a navigator's bounds.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable
from datetime import datetime
from typing import Any, Protocol

from correlate_sump.ingest import KINDS, stream_key
from correlate_sump.records import QueryError

#: At most this many sources in one question.
MAX_SOURCES = 200


class RedisEnds(Protocol):
    """The part of `redis.asyncio.Redis` this module uses."""

    def xrange(
        self, name: str, min: str = ..., max: str = ..., count: int | None = ...
    ) -> Awaitable[Any]: ...

    def xrevrange(
        self, name: str, max: str = ..., min: str = ..., count: int | None = ...
    ) -> Awaitable[Any]: ...


def _ts(entries: Any) -> datetime | None:
    """The time of the one entry in `entries`, if any."""
    for _id, raw in entries or []:
        data = raw.get(b"json", raw.get("json")) if raw else None
        if data is None:
            return None
        record = json.loads(data.decode() if isinstance(data, bytes) else data)
        return datetime.fromisoformat(record["ts"])
    return None


async def data_range(redis_client: RedisEnds, sources: list[str]) -> dict[str, Any]:
    """`{"from", "to"}`: the earliest and latest record of `sources`, ISO, or
    both `None` when they hold nothing."""
    if not sources or len(sources) > MAX_SOURCES:
        raise QueryError(f"sources are 1 to {MAX_SOURCES}")
    if any(not s or len(s) > 400 for s in sources):
        raise QueryError("a source is 1 to 400 characters")
    times: list[datetime] = []
    for source in sources:
        for kind in KINDS:
            key = stream_key(source, kind)
            first = _ts(await redis_client.xrange(key, min="-", max="+", count=1))
            last = _ts(await redis_client.xrevrange(key, max="+", min="-", count=1))
            times += [t for t in (first, last) if t is not None]
    if not times:
        return {"from": None, "to": None}
    return {"from": min(times).isoformat(), "to": max(times).isoformat()}
