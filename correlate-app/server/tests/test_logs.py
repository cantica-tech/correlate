"""REQ-000029-sJpO9KMY Requirement 1: a source's log rows by index, search,
and density."""

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import fakeredis.aioredis
import httpx
import pytest

from correlate_sump.app import create_app
from correlate_sump.ingest import stream_key
from correlate_sump.logs import find_row, log_density, log_page
from correlate_sump.records import QueryError

T0 = datetime(2026, 11, 21, 18, 0, tzinfo=UTC)


def at(seconds: float) -> datetime:
    return T0 + timedelta(seconds=seconds)


async def logs(n: int = 10) -> fakeredis.aioredis.FakeRedis:
    """`n` rows of `self/web`, one a second, "line 0" to "line n-1", plus one
    outside the range and one of another source."""
    redis = fakeredis.aioredis.FakeRedis()
    for i in range(n):
        record = {"kind": "log", "source": "self/web", "ts": at(i).isoformat(), "text": f"line {i}"}
        await redis.xadd(stream_key("self/web", "log"), {"json": json.dumps(record)})
    outside = {"kind": "log", "source": "self/web", "ts": at(-100).isoformat(), "text": "old"}
    await redis.xadd(stream_key("self/web", "log"), {"json": json.dumps(outside)})
    other = {"kind": "log", "source": "self/db", "ts": at(1).isoformat(), "text": "line 1"}
    await redis.xadd(stream_key("self/db", "log"), {"json": json.dumps(other)})
    return redis


async def test_pages_by_index_newest_or_oldest_first_with_the_total() -> None:
    redis = await logs()
    newest = await log_page(redis, "self/web", start=at(0), end=at(60), offset=0, limit=3)
    assert newest["total"] == 10
    assert [r["text"] for r in newest["rows"]] == ["line 9", "line 8", "line 7"]
    oldest = await log_page(
        redis, "self/web", start=at(0), end=at(60), offset=8, limit=5, order="oldest"
    )
    assert [r["text"] for r in oldest["rows"]] == ["line 8", "line 9"]
    past = await log_page(redis, "self/web", start=at(0), end=at(60), offset=50, limit=5)
    assert (past["total"], past["rows"]) == (10, [])


async def test_finds_the_next_and_previous_match() -> None:
    redis = await logs(30)
    args: dict[str, Any] = {"start": at(0), "end": at(60), "order": "oldest"}
    assert (await find_row(redis, "self/web", q="LINE 2", from_index=-1, **args))["index"] == 2
    assert (await find_row(redis, "self/web", q="line 2", from_index=2, **args))["index"] == 20
    assert (
        await find_row(redis, "self/web", q="line 2", from_index=20, direction="previous", **args)
    )["index"] == 2
    assert (await find_row(redis, "self/web", q="line 2", from_index=29, **args))["index"] is None
    assert (await find_row(redis, "self/web", q="nowhere", from_index=-1, **args))["index"] is None


async def test_counts_rows_per_bucket() -> None:
    redis = await logs()
    density = await log_density(redis, "self/web", start=at(0), end=at(10), buckets=5)
    assert density["counts"] == [2, 2, 2, 2, 2]
    assert density["total"] == 10


@pytest.mark.parametrize(
    ("call", "why"),
    [
        (lambda r: log_page(r, "s", start=at(0), end=at(0), offset=0, limit=1), "after from"),
        (lambda r: log_page(r, "s", start=at(0), end=at(1), offset=-1, limit=1), "0 or more"),
        (
            lambda r: log_page(r, "s", start=at(0), end=at(1), offset=0, limit=1001),
            "between 1 and 1000",
        ),
        (
            lambda r: log_page(r, "s", start=at(0), end=at(1), offset=0, limit=1, order="up"),
            "newest or oldest",
        ),
        (lambda r: find_row(r, "s", start=at(0), end=at(1), q="", from_index=0), "1 to 200"),
        (
            lambda r: find_row(r, "s", start=at(0), end=at(1), q="x", from_index=0, direction="up"),
            "next or previous",
        ),
        (lambda r: log_density(r, "s", start=at(0), end=at(1), buckets=0), "between 1 and 2000"),
    ],
)
async def test_refuses_a_bad_query(call, why: str) -> None:
    with pytest.raises(QueryError, match=why):
        await call(fakeredis.aioredis.FakeRedis())


async def test_the_routes_answer_behind_the_session() -> None:
    redis = await logs()
    app = create_app(redis_client=redis, env={}, start_ingest=False)
    async with app.router.lifespan_context(app):
        token = await app.state.sessions.issue("alice")
        auth = {"Authorization": f"Bearer {token}"}
        span = {"source": "self/web", "from": at(0).isoformat(), "to": at(60).isoformat()}
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://sump") as client:
            for path in ("/records/logs", "/records/logs/find", "/records/density"):
                assert (await client.get(path, params={**span, "q": "x"})).status_code == 401
            page = await client.get("/records/logs", params={**span, "limit": 2}, headers=auth)
            assert page.json()["total"] == 10
            found = await client.get(
                "/records/logs/find", params={**span, "q": "line 3"}, headers=auth
            )
            assert found.json()["index"] == 6
            density = await client.get(
                "/records/density", params={**span, "buckets": 6}, headers=auth
            )
            assert sum(density.json()["counts"]) == 10
            bad = await client.get("/records/logs", params={**span, "limit": 0}, headers=auth)
            assert bad.status_code == 422
