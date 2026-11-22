"""REQ-000037-sJpO9KMY Requirement 1: a recording's segment from the Sump."""

import json
from datetime import UTC, datetime, timedelta

import fakeredis.aioredis
import httpx
import pytest

from correlate_sump.app import create_app
from correlate_sump.ingest import stream_key
from correlate_sump.records import QueryError
from correlate_sump.segment import segment, stats_rows

T0 = datetime(2026, 11, 22, 12, 0, tzinfo=UTC)
MS = T0.timestamp() * 1000


def at(seconds: float) -> str:
    return (T0 + timedelta(seconds=seconds)).isoformat()


async def held() -> fakeredis.aioredis.FakeRedis:
    redis = fakeredis.aioredis.FakeRedis()

    async def add(source: str, kind: str, record: dict) -> None:
        body = {"kind": kind, "source": source, **record}
        await redis.xadd(stream_key(source, kind), {"json": json.dumps(body)})

    for i, (cpu, rx) in enumerate([(10.0, 1000), (20.0, 6000), (15.0, 6000)]):
        await add(
            "self/web",
            "metric",
            {
                "ts": at(i * 5),
                "cpu_percent": cpu,
                "mem_used_bytes": 50,
                "mem_limit_bytes": 200,
                "net_rx_bytes": rx,
                "net_tx_bytes": 0,
            },
        )
    await add("self/web", "log", {"ts": at(1), "text": "first"})
    await add("self/web", "log", {"ts": at(1), "text": "second, same time"})
    await add("self/web", "log", {"ts": at(99), "text": "outside"})
    await add("self/__host__", "metric", {"ts": at(2), "cpu_percent": 7.5})
    return redis


def test_stats_rows_hold_cttcs_columns_and_the_network_rate() -> None:
    rows = stats_rows(
        [
            {
                "ts": at(0),
                "cpu_percent": 1,
                "mem_used_bytes": 1,
                "mem_limit_bytes": 4,
                "net_rx_bytes": 0,
                "net_tx_bytes": 0,
            },
            {"ts": at(2), "cpu_percent": 2, "net_rx_bytes": 3000, "net_tx_bytes": 1000},
            {"ts": at(4), "net_rx_bytes": 10, "net_tx_bytes": 0},
        ]
    )
    assert rows == [
        [MS, 1.0, 25.0, 1.0, None],
        [MS + 2000, 2.0, None, None, 2000.0],
        # A counter that went down (a restart) gives no rate.
        [MS + 4000, None, None, None, None],
    ]


async def test_a_segment_holds_the_containers_the_host_and_the_logs() -> None:
    seg = await segment(
        await held(), ["self/web"], host="self/__host__", start=T0, end=T0 + timedelta(seconds=30)
    )
    assert seg["from"] == MS
    stats, host, logs = seg["sources"]
    assert stats["name"] == "stats@self"
    assert [r[1] for r in stats["series"]["web"]] == [10.0, 20.0, 15.0]
    assert [r[4] for r in stats["series"]["web"]] == [None, 1000.0, 0.0]
    assert host["is_host"] is True
    assert host["series"]["host@self"][0][1] == 7.5
    assert logs == {
        "type": "log",
        "name": "web",
        "rows": [
            {"ts": MS + 1000, "text": "first"},
            {"ts": MS + 1000, "text": "second, same time"},
        ],
    }


@pytest.mark.parametrize(
    ("sources", "why"),
    [(["web"], "stream/container"), (["x/" + "a" * 400], "1 to 400"), (["s/a"] * 201, "at most")],
)
async def test_refuses_bad_sources(sources: list[str], why: str) -> None:
    with pytest.raises(QueryError, match=why):
        await segment(
            fakeredis.aioredis.FakeRedis(),
            sources,
            host=None,
            start=T0,
            end=T0 + timedelta(seconds=1),
        )


async def test_the_route_answers_behind_the_session() -> None:
    app = create_app(redis_client=await held(), env={}, start_ingest=False)
    async with app.router.lifespan_context(app):
        token = await app.state.sessions.issue("alice")
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://sump") as client:
            query = {"sources": "self/web", "host": "self/__host__", "from": at(0), "to": at(30)}
            assert (await client.get("/records/segment", params=query)).status_code == 401
            auth = {"Authorization": f"Bearer {token}"}
            answer = await client.get("/records/segment", params=query, headers=auth)
            assert [s["type"] for s in answer.json()["sources"]] == ["stats", "stats", "log"]
            bad = await client.get("/records/segment", params={**query, "to": at(-1)}, headers=auth)
            assert bad.status_code == 422
