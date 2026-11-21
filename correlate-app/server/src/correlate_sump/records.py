"""The record query behind `GET /records` (br-RECORD-000003-sJpO9KMY).

Returns one source's records in a time range, by their own event time `ts`
(br-RECORD-000002-sJpO9KMY), oldest first, filtered by kind and optionally by
container, log level and text, one page at a time with a cursor per kind.

Started from correlator's `server/src/correlator_sump/records.py` (decision
D6 of `docs/roadmap/correlate-app-rewrite.md`), with REQ-000004-sJpO9KMY's
changes: invalid requests raise `QueryError` instead of being silently
adjusted; results sort by parsed time, not by the `ts` string; and a cursor
carries its record's event time and entry ID, so paging resumes correctly
even after that entry has been trimmed from its stream
(br-RECORD-000004-sJpO9KMY).

Every query reads its whole stream (`XRANGE - +`) and filters by `ts`, since
event time and stream order can differ. That is correlator's known
trade-off, acceptable while streams are capped and small.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from correlate_sump.ingest import KINDS, stream_key
from correlate_sump.otel import get_tracer

#: Records per kind returned when the caller does not ask for a page size.
DEFAULT_LIMIT = 200

#: The largest page size a caller may ask for.
MAX_LIMIT = 1000

#: How far back a query reaches when the caller gives no start.
DEFAULT_WINDOW = timedelta(hours=1)

#: `kind` values a query accepts: one record kind, or both.
QUERY_KINDS = (*KINDS, "both")


class QueryError(ValueError):
    """A query the Sump refuses, with a message saying why (HTTP 422)."""


class RedisLike(Protocol):
    """The part of `redis.asyncio.Redis` the query uses."""

    def xrange(self, name: str, min: str = ..., max: str = ...) -> Awaitable[Any]: ...


def _decode(value: Any) -> str:
    """A Redis value as text."""
    return value.decode() if isinstance(value, bytes) else value


def _parse_ts(value: str) -> datetime:
    """A record's event time; ingestion guarantees ISO 8601 with a timezone."""
    return datetime.fromisoformat(value)


def encode_cursor(ts: datetime, entry_id: str) -> str:
    """The cursor after a record: its event time and stream entry ID."""
    return f"{ts.isoformat()}|{entry_id}"


def decode_cursor(cursor: str) -> tuple[datetime, str]:
    """The event time and entry ID a cursor names; `QueryError` if it is malformed."""
    ts_text, sep, entry_id = cursor.partition("|")
    if not sep or not entry_id:
        raise QueryError(f"invalid cursor {cursor!r}")
    try:
        ts = datetime.fromisoformat(ts_text)
    except ValueError as exc:
        raise QueryError(f"invalid cursor {cursor!r}") from exc
    if ts.tzinfo is None:
        raise QueryError(f"invalid cursor {cursor!r}")
    return ts, entry_id


def _entry_order(entry_id: str) -> tuple[int, int]:
    """A Redis stream entry ID (`ms-seq`) as a sortable pair."""
    ms, _, seq = entry_id.partition("-")
    return int(ms), int(seq or 0)


def validate_query(kind: str, start: datetime, end: datetime, limit: int) -> None:
    """Raise `QueryError`, naming the problem, if the query can't be served."""
    if kind not in QUERY_KINDS:
        raise QueryError(f"kind must be one of {', '.join(QUERY_KINDS)}, got {kind!r}")
    if start.tzinfo is None or end.tzinfo is None:
        raise QueryError("from and to must include a timezone")
    if start > end:
        raise QueryError("from must not be after to")
    if not 1 <= limit <= MAX_LIMIT:
        raise QueryError(f"limit must be between 1 and {MAX_LIMIT}, got {limit}")


async def _fetch_kind(
    redis_client: RedisLike,
    source: str,
    kind: str,
    start: datetime,
    end: datetime,
    limit: int,
    cursor: str | None,
    keep: Callable[[dict[str, Any]], bool],
) -> tuple[list[dict[str, Any]], str | None]:
    """One page of one kind's matching records, and the cursor for the next page."""
    after = decode_cursor(cursor) if cursor is not None else None
    entries = await redis_client.xrange(stream_key(source, kind), min="-", max="+") or []
    matched: list[tuple[datetime, tuple[int, int], str, dict[str, Any]]] = []
    for entry_id_raw, fields in entries:
        if not fields:
            continue
        entry_id = _decode(entry_id_raw)
        record = json.loads(_decode(fields.get(b"json", fields.get("json"))))
        ts = _parse_ts(record["ts"])
        if not start <= ts <= end or not keep(record):
            continue
        matched.append((ts, _entry_order(entry_id), entry_id, record))
    matched.sort(key=lambda m: (m[0], m[1]))
    if after is not None:
        after_key = (after[0], _entry_order(after[1]))
        matched = [m for m in matched if (m[0], m[1]) > after_key]
    page = matched[:limit]
    next_cursor = encode_cursor(page[-1][0], page[-1][2]) if len(matched) > limit else None
    return [m[3] for m in page], next_cursor


async def query_records(
    redis_client: RedisLike,
    source: str,
    kind: str = "both",
    start: datetime | None = None,
    end: datetime | None = None,
    container_id: str | None = None,
    level: str | None = None,
    q: str | None = None,
    log_cursor: str | None = None,
    metric_cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
    now: datetime | None = None,
) -> dict[str, Any]:
    """`source`'s records in `[start, end]` (inclusive, by event time), oldest first.

    `kind` is `log`, `metric` or `both`; `container_id` filters both kinds,
    `level` and `q` (case-insensitive text in the message) filter logs. Each
    kind returns at most `limit` records and its own `next_*_cursor`, `None`
    once there is nothing more. Without `start`, the last hour up to `end` (or
    now). Raises `QueryError` for a query it refuses.
    """
    now = now or datetime.now(UTC)
    end = end or now
    start = start or end - DEFAULT_WINDOW
    validate_query(kind, start, end, limit)

    def keep(record: dict[str, Any]) -> bool:
        if container_id is not None and record.get("container_id") != container_id:
            return False
        if record["kind"] == "log":
            if level is not None and record.get("level") != level:
                return False
            if q is not None and q.lower() not in str(record.get("message", "")).lower():
                return False
        return True

    tracer = get_tracer()
    with tracer.start_as_current_span("sump.records.query") as span:
        span.set_attribute("sump.query.source", source)
        span.set_attribute("sump.query.kind", kind)
        results: list[dict[str, Any]] = []
        cursors: dict[str, str | None] = {"log": None, "metric": None}
        given = {"log": log_cursor, "metric": metric_cursor}
        for one_kind in KINDS:
            if kind in (one_kind, "both"):
                page, cursors[one_kind] = await _fetch_kind(
                    redis_client, source, one_kind, start, end, limit, given[one_kind], keep
                )
                results.extend(page)
        results.sort(key=lambda r: _parse_ts(r["ts"]))
        span.set_attribute("sump.query.result_count", len(results))
    return {
        "records": results,
        "next_log_cursor": cursors["log"],
        "next_metric_cursor": cursors["metric"],
    }
