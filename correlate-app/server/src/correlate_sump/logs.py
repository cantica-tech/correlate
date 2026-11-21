"""A source's log rows for the log panels and lanes (REQ-000029-sJpO9KMY
Requirement 1): by index over a time range, newest or oldest first, with
their total, so a virtual list knows its height and fetches only the pages in
view (cttc's panels paged by number); the next or previous row matching a
search; the row nearest a time, for the cursor (REQ-000030-sJpO9KMY); and
the rows' count per time bucket, for the event-density lanes.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from correlate_sump.ingest import stream_key
from correlate_sump.records import QueryError, RedisLike

#: At most this many rows in one page.
MAX_PAGE = 1000
#: At most this many density buckets.
MAX_BUCKETS = 2000
#: A search is at most this long.
MAX_QUERY = 200


def _check_range(start: datetime, end: datetime) -> None:
    if start.tzinfo is None or end.tzinfo is None:
        raise QueryError("from and to need a timezone")
    if end <= start:
        raise QueryError("to must be after from")


def _check_order(order: str) -> None:
    if order not in ("newest", "oldest"):
        raise QueryError("order is newest or oldest")


async def _rows(
    redis_client: RedisLike, source: str, start: datetime, end: datetime, order: str
) -> list[dict[str, Any]]:
    """Every log row of `source` in `[start, end]`, in `order`; ties by arrival."""
    entries = await redis_client.xrange(stream_key(source, "log"), min="-", max="+") or []
    rows: list[tuple[datetime, int, dict[str, Any]]] = []
    for n, (_id, raw) in enumerate(entries):
        if not raw:
            continue
        data = raw.get(b"json", raw.get("json"))
        record = json.loads(data.decode() if isinstance(data, bytes) else data)
        ts = datetime.fromisoformat(record["ts"])
        if start <= ts <= end:
            rows.append((ts, n, record))
    rows.sort(key=lambda r: (r[0], r[1]), reverse=order == "newest")
    return [r[2] for r in rows]


async def log_page(
    redis_client: RedisLike,
    source: str,
    *,
    start: datetime,
    end: datetime,
    offset: int,
    limit: int,
    order: str = "newest",
) -> dict[str, Any]:
    """The rows at `[offset, offset + limit)` of `source`'s log in `order`, and the total."""
    _check_range(start, end)
    _check_order(order)
    if offset < 0:
        raise QueryError("offset is 0 or more")
    if not 1 <= limit <= MAX_PAGE:
        raise QueryError(f"limit must be between 1 and {MAX_PAGE}, got {limit}")
    rows = await _rows(redis_client, source, start, end, order)
    return {"total": len(rows), "offset": offset, "rows": rows[offset : offset + limit]}


async def find_row(
    redis_client: RedisLike,
    source: str,
    *,
    start: datetime,
    end: datetime,
    q: str,
    from_index: int,
    direction: str = "next",
    order: str = "newest",
) -> dict[str, Any]:
    """The index of the next (or previous) row after (before) `from_index`
    whose text contains `q`, case-insensitively; `None` when there is none."""
    _check_range(start, end)
    _check_order(order)
    if direction not in ("next", "previous"):
        raise QueryError("direction is next or previous")
    if not q or len(q) > MAX_QUERY:
        raise QueryError(f"q is 1 to {MAX_QUERY} characters")
    needle = q.lower()
    rows = await _rows(redis_client, source, start, end, order)
    indexes = (
        range(from_index + 1, len(rows))
        if direction == "next"
        else range(min(from_index, len(rows)) - 1, -1, -1)
    )
    for i in indexes:
        if needle in str(rows[i].get("text", "")).lower():
            return {"index": i, "total": len(rows)}
    return {"index": None, "total": len(rows)}


async def nearest_row(
    redis_client: RedisLike,
    source: str,
    *,
    start: datetime,
    end: datetime,
    t: datetime,
    order: str = "newest",
) -> dict[str, Any]:
    """The index of the row whose time is nearest `t` in `order`, the earlier
    index on a tie; `None` when there are no rows (REQ-000030-sJpO9KMY), for
    a panel following the cursor, as cttc's `index_at`."""
    _check_range(start, end)
    _check_order(order)
    if t.tzinfo is None:
        raise QueryError("t needs a timezone")
    rows = await _rows(redis_client, source, start, end, order)
    best: int | None = None
    best_gap = 0.0
    for i, row in enumerate(rows):
        gap = abs((datetime.fromisoformat(row["ts"]) - t).total_seconds())
        if best is None or gap < best_gap:
            best, best_gap = i, gap
    return {"index": best, "total": len(rows)}


async def log_density(
    redis_client: RedisLike, source: str, *, start: datetime, end: datetime, buckets: int
) -> dict[str, Any]:
    """How many log rows of `source` fall in each of `buckets` over `[start, end]`."""
    _check_range(start, end)
    if not 1 <= buckets <= MAX_BUCKETS:
        raise QueryError(f"buckets must be between 1 and {MAX_BUCKETS}, got {buckets}")
    rows = await _rows(redis_client, source, start, end, "oldest")
    span = (end - start).total_seconds()
    counts = [0] * buckets
    for row in rows:
        t = datetime.fromisoformat(row["ts"])
        counts[min(buckets - 1, int((t - start).total_seconds() / span * buckets))] += 1
    return {"buckets": buckets, "counts": counts, "total": len(rows)}
