"""REQ-000028-sJpO9KMY Requirement 1: a metric over a time range as at most N
buckets, each its maximum."""

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import fakeredis.aioredis
import httpx
import pytest

from correlate_sump.app import create_app
from correlate_sump.buckets import bucket_values, query_buckets
from correlate_sump.ingest import stream_key
from correlate_sump.records import QueryError

T0 = datetime(2026, 11, 21, 18, 0, tzinfo=UTC)


def at(seconds: float) -> datetime:
    return T0 + timedelta(seconds=seconds)


async def store(redis, source: str, *records: dict) -> None:
    for r in records:
        await redis.xadd(
            stream_key(source, "metric"),
            {"json": json.dumps({"kind": "metric", "source": source, **r})},
        )


def test_a_short_spike_survives_every_bucket_size() -> None:
    """cttc's BUCKET lesson: a mean hid spikes; the maximum keeps them."""
    points = [(at(s), 1.0) for s in range(600)]
    points[317] = (at(317), 95.0)
    for buckets in (1, 7, 60, 600):
        values = bucket_values(points, at(0), at(600), buckets, "max")
        assert max(v for v in values if v is not None) == 95.0


def test_empty_buckets_are_null_and_the_last_takes_the_end() -> None:
    assert bucket_values([(at(0), 1.0), (at(10), 2.0)], at(0), at(10), 5, "max") == [
        1.0,
        None,
        None,
        None,
        2.0,
    ]


def test_a_counters_rate_drops_a_reset() -> None:
    points = [(at(0), 0.0), (at(5), 500.0), (at(10), 1500.0), (at(15), 100.0), (at(20), 600.0)]
    # Rates land at their later record: 5 s, 10 s, (15 s reset dropped), 20 s.
    assert bucket_values(points, at(0), at(20), 4, "rate") == [None, 100.0, 200.0, 100.0]


async def test_reads_sums_and_percentages_from_the_records() -> None:
    redis = fakeredis.aioredis.FakeRedis()
    await store(
        redis,
        "self/web",
        {
            "ts": at(1).isoformat(),
            "mem_used_bytes": 50,
            "mem_limit_bytes": 200,
            "net_rx_bytes": 10,
            "net_tx_bytes": 0,
        },
        {
            "ts": at(6).isoformat(),
            "mem_used_bytes": 100,
            "mem_limit_bytes": 200,
            "net_rx_bytes": 40,
            "net_tx_bytes": 20,
        },
        {
            "ts": at(11).isoformat(),
            "mem_used_bytes": None,
            "mem_limit_bytes": 200,
            "net_rx_bytes": 90,
            "net_tx_bytes": 20,
        },
    )
    mem = await query_buckets(
        redis,
        "self/web",
        fields=["mem_used_bytes"],
        over="mem_limit_bytes",
        start=at(0),
        end=at(12),
        buckets=3,
    )
    assert mem["values"] == [25.0, 50.0, None]
    net = await query_buckets(
        redis,
        "self/web",
        fields=["net_rx_bytes", "net_tx_bytes"],
        start=at(0),
        end=at(12),
        buckets=3,
        mode="rate",
    )
    assert net["values"] == [None, 10.0, 10.0]


@pytest.mark.parametrize(
    ("kwargs", "why"),
    [
        ({"fields": []}, "at least one field"),
        ({"fields": ["a b"]}, "not a field name"),
        ({"fields": ["cpu_percent"], "buckets": 0}, "between 1 and 2000"),
        ({"fields": ["cpu_percent"], "buckets": 2001}, "between 1 and 2000"),
        ({"fields": ["cpu_percent"], "mode": "mean"}, "max or rate"),
        ({"fields": ["cpu_percent"], "end": at(0)}, "after from"),
    ],
)
async def test_refuses_a_bad_query(kwargs: dict, why: str) -> None:
    args: dict[str, Any] = {"start": at(0), "end": at(10), "buckets": 10, **kwargs}
    with pytest.raises(QueryError, match=why):
        await query_buckets(fakeredis.aioredis.FakeRedis(), "s", **args)


async def test_the_route_answers_behind_the_session() -> None:
    redis = fakeredis.aioredis.FakeRedis()
    await store(redis, "self/web", {"ts": at(1).isoformat(), "cpu_percent": 12.5})
    app = create_app(redis_client=redis, env={}, start_ingest=False)
    async with app.router.lifespan_context(app):
        token = await app.state.sessions.issue("alice")
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://sump") as client:
            query = {
                "source": "self/web",
                "from": at(0).isoformat(),
                "to": at(10).isoformat(),
                "field": "cpu_percent",
                "buckets": 2,
            }
            assert (await client.get("/records/buckets", params=query)).status_code == 401
            answer = await client.get(
                "/records/buckets", params=query, headers={"Authorization": f"Bearer {token}"}
            )
            assert answer.status_code == 200
            assert answer.json()["values"] == [12.5, None]
            summed = await client.get(
                "/records/buckets",
                params={**query, "field": "cpu_percent,cpu_percent"},
                headers={"Authorization": f"Bearer {token}"},
            )
            assert summed.json()["values"] == [25.0, None]
            bad = await client.get(
                "/records/buckets",
                params={**query, "buckets": 0},
                headers={"Authorization": f"Bearer {token}"},
            )
            assert bad.status_code == 422
