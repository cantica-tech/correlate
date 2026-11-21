"""The record query (REQ-000004-sJpO9KMY Requirement 2): br-RECORD-000002-sJpO9KMY
(event time) and br-RECORD-000003-sJpO9KMY (time range, filters, paging,
refusals)."""

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import fakeredis.aioredis
import pytest

from correlate_sump.ingest import IngestAdapter
from correlate_sump.records import (
    MAX_LIMIT,
    QueryError,
    decode_cursor,
    encode_cursor,
    query_records,
)

T0 = datetime(2026, 11, 21, 10, 0, tzinfo=UTC)


def at(seconds: float) -> str:
    return (T0 + timedelta(seconds=seconds)).isoformat()


@pytest.fixture
def redis_client():
    return fakeredis.aioredis.FakeRedis()


@pytest.fixture
def adapter(redis_client):
    return IngestAdapter(redis_client, maxlen=1000)


async def put(adapter, **fields) -> None:
    record = {"kind": "log", "source": "h1", "ts": at(0), "message": "m"}
    record.update(fields)
    assert await adapter.ingest(json.dumps(record).encode())


async def test_range_is_inclusive_and_by_event_time(redis_client, adapter) -> None:
    for s in (-1, 0, 5, 10, 11):
        await put(adapter, ts=at(s), message=f"s{s}")
    result = await query_records(
        redis_client, "h1", "log", start=T0, end=T0 + timedelta(seconds=10)
    )
    assert [r["message"] for r in result["records"]] == ["s0", "s5", "s10"]


async def test_event_time_not_arrival_order_decides(redis_client, adapter) -> None:
    # Arrives last but happened first: still first, and outside a range that
    # starts after it even though it arrived inside the query window.
    await put(adapter, ts=at(5), message="second")
    await put(adapter, ts=at(1), message="first")
    result = await query_records(redis_client, "h1", "log", start=T0, end=T0 + timedelta(seconds=9))
    assert [r["message"] for r in result["records"]] == ["first", "second"]
    later = await query_records(
        redis_client, "h1", "log", start=T0 + timedelta(seconds=2), end=T0 + timedelta(seconds=9)
    )
    assert [r["message"] for r in later["records"]] == ["second"]


async def test_mixed_timezones_sort_by_instant(redis_client, adapter) -> None:
    await put(adapter, ts="2026-11-21T11:00:02+01:00", message="b")  # 10:00:02Z
    await put(adapter, ts="2026-11-21T10:00:01+00:00", message="a")
    result = await query_records(redis_client, "h1", "log", start=T0, end=T0 + timedelta(seconds=9))
    assert [r["message"] for r in result["records"]] == ["a", "b"]


async def test_kind_filters_and_both_interleaves(redis_client, adapter) -> None:
    await put(adapter, kind="log", ts=at(1), message="log1")
    await put(adapter, kind="metric", ts=at(2), cpu=0.5)
    await put(adapter, kind="log", ts=at(3), message="log3")
    window: dict[str, Any] = {"start": T0, "end": T0 + timedelta(seconds=9)}
    logs = await query_records(redis_client, "h1", "log", **window)
    metrics = await query_records(redis_client, "h1", "metric", **window)
    both = await query_records(redis_client, "h1", "both", **window)
    assert [r["kind"] for r in logs["records"]] == ["log", "log"]
    assert [r["kind"] for r in metrics["records"]] == ["metric"]
    assert [r["kind"] for r in both["records"]] == ["log", "metric", "log"]


async def test_sources_are_separate(redis_client, adapter) -> None:
    await put(adapter, source="h1", ts=at(1))
    await put(adapter, source="h2", ts=at(1))
    result = await query_records(redis_client, "h2", "log", start=T0, end=T0 + timedelta(seconds=9))
    assert [r["source"] for r in result["records"]] == ["h2"]


async def test_container_level_and_text_filters(redis_client, adapter) -> None:
    await put(adapter, ts=at(1), container_id="c1", level="ERROR", message="Disk FULL")
    await put(adapter, ts=at(2), container_id="c2", level="ERROR", message="disk full")
    await put(adapter, ts=at(3), container_id="c1", level="INFO", message="disk ok")
    window: dict[str, Any] = {"start": T0, "end": T0 + timedelta(seconds=9)}
    by_container = await query_records(redis_client, "h1", "log", container_id="c1", **window)
    assert len(by_container["records"]) == 2
    by_level = await query_records(redis_client, "h1", "log", level="ERROR", **window)
    assert len(by_level["records"]) == 2
    by_text = await query_records(redis_client, "h1", "log", q="disk full", **window)
    assert len(by_text["records"]) == 2


async def test_paging_has_no_gap_or_duplicate(redis_client, adapter) -> None:
    for s in range(25):
        await put(adapter, ts=at(s), message=f"m{s}")
    window: dict[str, Any] = {"start": T0, "end": T0 + timedelta(seconds=99)}
    seen, cursor = [], None
    while True:
        page = await query_records(redis_client, "h1", "log", log_cursor=cursor, limit=10, **window)
        seen += [r["message"] for r in page["records"]]
        cursor = page["next_log_cursor"]
        if cursor is None:
            break
    assert seen == [f"m{s}" for s in range(25)]


async def test_records_with_the_same_time_page_cleanly(redis_client, adapter) -> None:
    for i in range(5):
        await put(adapter, ts=at(1), message=f"same{i}")
    window: dict[str, Any] = {"start": T0, "end": T0 + timedelta(seconds=9)}
    first = await query_records(redis_client, "h1", "log", limit=2, **window)
    rest = await query_records(
        redis_client, "h1", "log", limit=10, log_cursor=first["next_log_cursor"], **window
    )
    assert [r["message"] for r in first["records"] + rest["records"]] == [
        f"same{i}" for i in range(5)
    ]


async def test_paging_survives_trimming_of_the_cursor_record(redis_client) -> None:
    adapter = IngestAdapter(redis_client, maxlen=5)
    for s in range(5):
        await put(adapter, ts=at(s), message=f"m{s}")
    window: dict[str, Any] = {"start": T0, "end": T0 + timedelta(seconds=99)}
    first = await query_records(redis_client, "h1", "log", limit=2, **window)
    assert [r["message"] for r in first["records"]] == ["m0", "m1"]
    for s in range(5, 8):  # trims m0, m1 and m2, including the cursor's record
        await put(adapter, ts=at(s), message=f"m{s}")
    rest = await query_records(
        redis_client, "h1", "log", limit=10, log_cursor=first["next_log_cursor"], **window
    )
    assert [r["message"] for r in rest["records"]] == ["m3", "m4", "m5", "m6", "m7"]


async def test_default_window_is_the_last_hour(redis_client, adapter) -> None:
    now = T0 + timedelta(hours=3)
    await put(adapter, ts=(now - timedelta(minutes=30)).isoformat(), message="recent")
    await put(adapter, ts=(now - timedelta(hours=2)).isoformat(), message="old")
    result = await query_records(redis_client, "h1", "log", now=now)
    assert [r["message"] for r in result["records"]] == ["recent"]


async def test_query_is_traced(redis_client, adapter, otel) -> None:
    exporter, _ = otel
    await query_records(redis_client, "h1", "log", start=T0, end=T0)
    assert "sump.records.query" in {s.name for s in exporter.get_finished_spans()}


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"kind": "container"}, "kind must be one of"),
        ({"start": T0 + timedelta(seconds=1), "end": T0}, "from must not be after to"),
        ({"start": datetime(2026, 1, 1), "end": T0}, "must include a timezone"),
        ({"limit": 0}, "limit must be between 1 and"),
        ({"limit": MAX_LIMIT + 1}, "limit must be between 1 and"),
        ({"log_cursor": "nonsense"}, "invalid cursor"),
    ],
)
async def test_invalid_queries_are_refused(redis_client, kwargs, message) -> None:
    args: dict[str, Any] = {"kind": "log", "start": T0, "end": T0 + timedelta(seconds=1)} | kwargs
    with pytest.raises(QueryError, match=message):
        await query_records(redis_client, "h1", **args)


def test_cursor_round_trips() -> None:
    assert decode_cursor(encode_cursor(T0, "1700000000000-3")) == (T0, "1700000000000-3")
