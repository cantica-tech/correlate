"""A metric's values over a time range as at most N buckets (REQ-000028-sJpO9KMY
Requirement 1), for the charts: the app never fetches more points than a plot
is wide.

Each bucket keeps the **maximum** of its values, never the mean: a mean hid
every short spike in cttc (its `BUCKET` lesson). A record's value is the sum of
one or more fields (NET: bytes received plus sent), optionally a percentage of
another field (MEM %: used over the limit); in `rate` mode, a cumulative
counter's per-second rate between consecutive records, a reset (a counter that
went down) dropped.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Literal

from correlate_sump.ingest import stream_key
from correlate_sump.records import QueryError, RedisLike

#: At most this many buckets in one answer.
MAX_BUCKETS = 2000
#: Field names a record may be read by: letters, digits and underscores.
_FIELD_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")


def _check(
    fields: list[str], over: str | None, buckets: int, start: datetime, end: datetime
) -> None:
    if not fields:
        raise QueryError("at least one field is needed")
    for name in [*fields, *([over] if over else [])]:
        if not name or len(name) > 64 or not set(name) <= _FIELD_CHARS:
            raise QueryError(f"not a field name: {name!r}")
    if not 1 <= buckets <= MAX_BUCKETS:
        raise QueryError(f"buckets must be between 1 and {MAX_BUCKETS}, got {buckets}")
    if start.tzinfo is None or end.tzinfo is None:
        raise QueryError("from and to need a timezone")
    if end <= start:
        raise QueryError("to must be after from")


def _value(record: dict[str, Any], fields: list[str], over: str | None) -> float | None:
    total = 0.0
    for name in fields:
        part = record.get(name)
        if not isinstance(part, int | float) or isinstance(part, bool):
            return None
        total += part
    if over is None:
        return total
    base = record.get(over)
    if not isinstance(base, int | float) or isinstance(base, bool) or base <= 0:
        return None
    return total / base * 100.0


def bucket_values(
    points: list[tuple[datetime, float]],
    start: datetime,
    end: datetime,
    buckets: int,
    mode: Literal["max", "rate"],
) -> list[float | None]:
    """`points` (time, value), oldest first, as `buckets` maxima over `[start, end]`."""
    if mode == "rate":
        rates: list[tuple[datetime, float]] = []
        for (t0, v0), (t1, v1) in zip(points, points[1:], strict=False):
            seconds = (t1 - t0).total_seconds()
            if seconds > 0 and v1 >= v0:
                rates.append((t1, (v1 - v0) / seconds))
        points = rates
    span = (end - start).total_seconds()
    out: list[float | None] = [None] * buckets
    for t, v in points:
        if not start <= t <= end:
            continue
        index = min(buckets - 1, int((t - start).total_seconds() / span * buckets))
        current = out[index]
        out[index] = v if current is None or v > current else current
    return out


async def query_buckets(
    redis_client: RedisLike,
    source: str,
    *,
    fields: list[str],
    start: datetime,
    end: datetime,
    buckets: int,
    over: str | None = None,
    mode: str = "max",
) -> dict[str, Any]:
    """`source`'s metric values over `[start, end]` as `buckets` maxima."""
    if mode not in ("max", "rate"):
        raise QueryError("mode is max or rate")
    _check(fields, over, buckets, start, end)
    entries = await redis_client.xrange(stream_key(source, "metric"), min="-", max="+") or []
    points: list[tuple[datetime, float]] = []
    for _id, raw in entries:
        if not raw:
            continue
        data = raw.get(b"json", raw.get("json"))
        record = json.loads(data.decode() if isinstance(data, bytes) else data)
        value = _value(record, fields, over)
        if value is None:
            continue
        points.append((datetime.fromisoformat(record["ts"]), value))
    points.sort(key=lambda p: p[0])
    # A rate needs the record just before the range to rate its first one.
    if mode == "rate":
        before = [p for p in points if p[0] < start][-1:]
        points = before + [p for p in points if start <= p[0] <= end]
    return {
        "source": source,
        "from": start.isoformat(),
        "to": end.isoformat(),
        "buckets": buckets,
        "values": bucket_values(points, start, end, buckets, mode),  # type: ignore[arg-type]
    }
